import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";

const managers: SessionManager[] = [];
const dirs: TempDir[] = [];
const message = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
async function fixture() {
	const dir = TempDir.createSync("omp-journal-safety-");
	dirs.push(dir);
	const first = SessionManager.create(dir.path(), dir.path(), new FileSessionStorage());
	managers.push(first);
	await first.ensureOnDisk();
	const root = first.appendMessage(message("ORIGINAL"));
	await first.flush();
	const file = first.getSessionFile()!;
	const second = await SessionManager.open(file, dir.path(), new FileSessionStorage(), { suppressBreadcrumb: true });
	managers.push(second);
	return { first, second, file, root, dir };
}
afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.close().catch(() => {});
	for (const dir of dirs.splice(0)) await dir.remove();
});

describe("file journal transactional reconciliation", () => {
	it("preserves same-size remote edits even if modification time is restored", async () => {
		const { first, second, file, root } = await fixture();
		const before = fs.statSync(file);
		const changed = second.getEntry(root)!;
		if (changed.type !== "message" || changed.message.role !== "user") throw new Error("expected user");
		changed.message.content = "REPLACED";
		await second.rewriteEntries();
		fs.utimesSync(file, before.atime, before.mtime);
		await first.rewriteEntries();
		expect(first.getEntry(root)).toMatchObject({ message: { content: "REPLACED" } });
		expect(await Bun.file(file).text()).toContain("REPLACED");
	});
	it("rejects conflicting edits without changing the peer journal", async () => {
		const { first, second, file, root } = await fixture();
		for (const [manager, content] of [
			[first, "LOCALONE"],
			[second, "PEEREDIT"],
		] as const) {
			const entry = manager.getEntry(root)!;
			if (entry.type !== "message" || entry.message.role !== "user") throw new Error("expected user");
			entry.message.content = content;
		}
		await second.rewriteEntries();
		const peer = await Bun.file(file).text();
		await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(await Bun.file(file).text()).toBe(peer);
	});
	it("rejects another session header even when size and timestamps match", async () => {
		const { first, file } = await fixture();
		const original = await Bun.file(file).text();
		const foreign = original.replace(first.getSessionId(), "0".repeat(first.getSessionId().length));
		await Bun.write(file, foreign);
		await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(await Bun.file(file).text()).toBe(foreign);
	});
	it("rejects new corruption and duplicate ids without discarding bytes", async () => {
		const { first, file, root } = await fixture();
		const original = await Bun.file(file).text();
		const duplicate = `${original}${JSON.stringify(first.getEntry(root))}\n`;
		await Bun.write(file, duplicate);
		await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(await Bun.file(file).text()).toBe(duplicate);
	});
	it("hydrates a foreign image before exposing the adopted branch", async () => {
		const { first, file, root } = await fixture();
		const bytes = Buffer.from("foreign-image-payload");
		const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		const originalGet = BlobStore.prototype.getSync;
		spyOn(BlobStore.prototype, "getSync").mockImplementation(function (this: BlobStore, key) {
			return key === hash ? bytes : originalGet.call(this, key);
		});
		const entry = {
			type: "message",
			id: "foreign-image",
			parentId: root,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "user",
				content: [{ type: "image", mimeType: "image/png", data: `blob:sha256:${hash}` }],
				timestamp: 1,
			},
		};
		fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
		const leaf = first.getLeafId();
		await first.rewriteEntries();
		expect(first.getLeafId()).toBe(leaf);
		expect(first.getEntry(entry.id)).toMatchObject({
			message: { content: [{ type: "image", data: bytes.toString("base64") }] },
		});
	});
	it("makes sequential synchronous appends durable before flushSync returns", async () => {
		const { first, second, file, dir } = await fixture();
		// Force a cold rewrite, then let the peer advance it before the next local append.
		const state = first.captureState();
		state.needsRewrite = true;
		first.restoreState(state);
		second.appendMessage(message("peer"));
		await second.rewriteEntries();
		const a = first.appendMessage(message("local-a"));
		const b = first.appendMessage(message("local-b"));
		first.flushSync();
		const fresh = await SessionManager.open(file, dir.path(), new FileSessionStorage(), { suppressBreadcrumb: true });
		managers.push(fresh);
		expect(fresh.getEntry(a)).toMatchObject({ message: { content: "local-a" } });
		expect(fresh.getEntry(b)).toMatchObject({ parentId: a, message: { content: "local-b" } });
	});
	it("does not resurrect a peer's deleted entry", async () => {
		const { first, second, file, root } = await fixture();
		await second.discardEntryDurably(root);
		await first.rewriteEntries();
		expect(first.getEntry(root)).toBeUndefined();
		expect(await Bun.file(file).text()).not.toContain('"content":"ORIGINAL"');
	});
	it("keeps the original file on a partial staged write and recovers from ENOSPC", async () => {
		const { first, file } = await fixture();
		const before = await Bun.file(file).text();
		const write = spyOn(fs, "writeSync").mockImplementation(() => {
			throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
		});
		first.appendMessage(message("unsaved"));
		await expect(first.flush()).rejects.toThrow("disk full");
		expect(await Bun.file(file).text()).toBe(before);
		write.mockRestore();
		first.appendMessage(message("recovered"));
		first.flushSync();
		const after = await Bun.file(file).text();
		expect(after).toContain("unsaved");
		expect(after).toContain("recovered");
	});
	it("preserves a peer's newer title while rewriting another branch", async () => {
		const { first, second, file, dir } = await fixture();
		await second.setSessionName("peer title", "user");
		first.appendMessage(message("local branch"));
		await first.rewriteEntries();
		const fresh = await SessionManager.open(file, dir.path(), new FileSessionStorage(), { suppressBreadcrumb: true });
		managers.push(fresh);
		expect(first.getSessionName()).toBe("peer title");
		expect(fresh.getSessionName()).toBe("peer title");
	});
	it("does not overwrite a peer branch if staged reconciliation runs out of disk", async () => {
		const { first, second, file } = await fixture();
		second.appendMessage(message("peer durable"));
		await second.rewriteEntries();
		const peer = await Bun.file(file).text();
		const originalWrite = fs.writeSync;
		let writes = 0;
		const failing = spyOn(fs, "writeSync").mockImplementation((...args: unknown[]) => {
			if (++writes > 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
			return Reflect.apply(originalWrite, fs, args) as number;
		});
		await expect(first.rewriteEntries()).rejects.toThrow("disk full");
		expect(await Bun.file(file).text()).toBe(peer);
		failing.mockRestore();
		first.appendMessage(message("local recovery"));
		first.flushSync();
		expect(await Bun.file(file).text()).toContain("peer durable");
		expect(await Bun.file(file).text()).toContain("local recovery");
	});
});

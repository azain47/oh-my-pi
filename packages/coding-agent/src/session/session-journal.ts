import type { FileEntry, SessionEntry, SessionHeader } from "./session-entries";
import { parseTitleSlotLine, serializeTitleSlot, titleUpdateFromSlot } from "./session-title-slot";

export class SessionJournalConflictError extends Error {}

/** Baseline content hashes, not another copy of the transcript. */
export interface JournalBaseline {
	entries: Map<string, string>;
	malformed: Map<string, number>;
	migrationHashes?: readonly string[];
	title?: string;
}

export function journalHash(line: string): string {
	return new Bun.CryptoHasher("sha256").update(line).digest("hex");
}

export function journalRecordHash(entry: FileEntry): string {
	return journalHash(
		JSON.stringify(entry.type === "session" ? { type: entry.type, id: entry.id, version: entry.version } : entry),
	);
}

export interface JournalMerge {
	entries: SessionEntry[];
	baseline: JournalBaseline;
	lines: Iterable<string>;
	title: string;
}

/** Three-way record merge. The caller publishes the generator under the file lock,
 * and installs entries/baseline only after the atomic replacement succeeds. */
export function mergeSessionJournal(
	current: Iterable<string> | null,
	header: SessionHeader,
	title: string,
	local: readonly SessionEntry[],
	baseline: JournalBaseline,
	serialize: (entry: FileEntry) => string,
	hydrate: (entries: FileEntry[]) => void,
	allowEmpty = false,
): JournalMerge {
	const result: JournalMerge = {
		entries: [],
		baseline: { entries: new Map(), malformed: new Map() },
		lines: [],
		title,
	};
	result.lines = merge();
	return result;

	function* merge(): Generator<string> {
		const localById = new Map(local.map(entry => [entry.id, entry]));
		if (localById.size !== local.length) throw new SessionJournalConflictError("Duplicate local entry ids.");
		const baselineIds = new Map(Array.from(baseline.entries, ([id, hash]) => [hash, id]));
		const seen = new Set<string>();
		const malformed = new Map(baseline.malformed);
		let sawHeader = false;
		let firstLine = true;
		let migrationIndex = 0;
		if (current === null && baseline.entries.size > 0) {
			throw new SessionJournalConflictError("Session journal disappeared; refusing to recreate stale history.");
		}
		if (current !== null) {
			for (const line of current) {
				if (firstLine) {
					firstLine = false;
					const slot = titleUpdateFromSlot(parseTitleSlotLine(line.trim()));
					if (slot) {
						const remoteTitle = serializeTitleSlot(slot);
						if (baseline.title !== undefined && remoteTitle !== baseline.title && remoteTitle !== title) {
							if (title !== baseline.title)
								throw new SessionJournalConflictError("Concurrent session title edits conflict.");
							result.title = remoteTitle;
						}
						continue;
					}
				}
				if (!line.trim()) continue;
				// Exact baseline records need neither parsing nor a second full
				// serialization. Keep only one line's transient data for large histories.
				if (sawHeader && !baseline.migrationHashes) {
					const knownId = baselineIds.get(journalHash(line));
					if (knownId !== undefined) {
						if (seen.has(knownId)) throw new SessionJournalConflictError(`Duplicate session entry ${knownId}.`);
						seen.add(knownId);
						const ours = localById.get(knownId);
						if (ours) {
							const oursLine = serialize(ours);
							result.entries.push(ours);
							result.baseline.entries.set(knownId, journalHash(oursLine));
							yield oursLine;
						}
						continue;
					}
				}
				let value: FileEntry;
				try {
					value = JSON.parse(line) as FileEntry;
				} catch {
					const hash = journalHash(line);
					const count = malformed.get(hash) ?? 0;
					if (count > 0) {
						malformed.set(hash, count - 1);
						continue;
					}
					throw new SessionJournalConflictError(
						"Session journal contains new malformed data; the file was not modified.",
					);
				}
				if (baseline.migrationHashes) {
					if (journalRecordHash(value) !== baseline.migrationHashes[migrationIndex++]) {
						throw new SessionJournalConflictError(
							"Legacy session changed during migration; the file was not modified.",
						);
					}
				}
				if (!sawHeader) {
					if (!value || value.type !== "session" || value.id !== header.id) {
						throw new SessionJournalConflictError("Session identity changed; the file was not modified.");
					}
					sawHeader = true;
					yield result.title;
					yield serialize(header);
					continue;
				}
				if (baseline.migrationHashes) continue;
				if (
					!value ||
					value.type === "session" ||
					typeof value.id !== "string" ||
					(value.parentId !== null && typeof value.parentId !== "string")
				) {
					throw new SessionJournalConflictError("Invalid session journal record; the file was not modified.");
				}
				if (seen.has(value.id))
					throw new SessionJournalConflictError(`Duplicate session entry ${value.id}; the file was not modified.`);
				seen.add(value.id);
				const remoteLine = serialize(value);
				const remoteHash = journalHash(remoteLine);
				const previous = baseline.entries.get(value.id);
				const ours = localById.get(value.id);
				let chosen: SessionEntry;
				let chosenLine: string;
				if (!ours) {
					if (previous !== undefined) {
						if (previous !== remoteHash)
							throw new SessionJournalConflictError(
								`Concurrent edit/delete conflict for session entry ${value.id}.`,
							);
						continue;
					}
					chosen = value;
					chosenLine = remoteLine;
				} else {
					const oursLine = serialize(ours);
					const oursHash = journalHash(oursLine);
					if (oursHash === remoteHash || remoteHash === previous) {
						chosen = ours;
						chosenLine = oursLine;
					} else if (oursHash === previous) {
						chosen = value;
						chosenLine = remoteLine;
					} else {
						throw new SessionJournalConflictError(
							`Concurrent edits conflict for session entry ${value.id}; the file was not modified.`,
						);
					}
				}
				if (chosen === value) hydrate([chosen]);
				result.entries.push(chosen);
				result.baseline.entries.set(chosen.id, journalHash(chosenLine));
				yield chosenLine;
			}
			if (!sawHeader && !allowEmpty)
				throw new SessionJournalConflictError(
					"Session journal is empty or has no header; the file was not modified.",
				);
		}
		if (!sawHeader) {
			yield result.title;
			yield serialize(header);
		}
		result.baseline.title = result.title;
		if (baseline.migrationHashes && migrationIndex !== baseline.migrationHashes.length) {
			throw new SessionJournalConflictError("Legacy session changed during migration; the file was not modified.");
		}
		for (const ours of local) {
			if (seen.has(ours.id)) continue;
			const line = serialize(ours);
			const hash = journalHash(line);
			const previous = baseline.entries.get(ours.id);
			if (previous !== undefined && current !== null && !baseline.migrationHashes) {
				if (hash !== previous)
					throw new SessionJournalConflictError(`Concurrent delete/edit conflict for session entry ${ours.id}.`);
				continue;
			}
			result.entries.push(ours);
			result.baseline.entries.set(ours.id, hash);
			yield line;
		}
		const retained = new Set(result.entries.map(entry => entry.id));
		for (const entry of result.entries) {
			if (
				entry.parentId &&
				!retained.has(entry.parentId) &&
				(baseline.entries.has(entry.parentId) || seen.has(entry.parentId))
			) {
				throw new SessionJournalConflictError(`Concurrent deletion removed parent ${entry.parentId}.`);
			}
		}
	}
}

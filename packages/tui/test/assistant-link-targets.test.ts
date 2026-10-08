import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ImageBudget } from "../src/components/image";
import {
	type AssistantMessageHost,
	getAssistantMessageLinkTargets,
	refreshAssistantMessageLinkTargets,
} from "../src/prompt/interactive-context-helpers";

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

/** Host whose link resolutions stay pending until the test settles them, in issue order. */
function deferredHost() {
	const requests: PromiseWithResolvers<ReadonlyMap<string, string>>[] = [];
	const host: AssistantMessageHost = {
		viewSession: {},
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
		expandThinkingBlocks: false,
		assistantImagesVisible: true,
		tableChartsVisible: true,
		hideToolActivity: false,
		toolOutputExpanded: false,
		ui: { requestRender() {}, imageBudget: new ImageBudget() },
		resolveAssistantMessageLinkHrefs() {
			const request = Promise.withResolvers<ReadonlyMap<string, string>>();
			requests.push(request);
			return request.promise;
		},
	};
	return { host, requests };
}

describe("refreshAssistantMessageLinkTargets", () => {
	test("keeps links committed by a concurrent refresh that resolved first", async () => {
		const { host, requests } = deferredHost();

		// A wider transcript redraw and a just-finished reply resolve their links concurrently.
		const redraw = refreshAssistantMessageLinkTargets(host, [reply("Older note in [a](a.ts).")]);
		const finished = refreshAssistantMessageLinkTargets(host, [reply("New note in [b](b.ts).")]);
		requests[1]!.resolve(new Map([["b.ts", "/repo/b.ts"]]));
		await finished;
		requests[0]!.resolve(new Map([["a.ts", "/repo/a.ts"]]));
		await redraw;

		const targets = getAssistantMessageLinkTargets(host);
		expect(targets.get("a.ts")).toBe("/repo/a.ts");
		expect(targets.get("b.ts")).toBe("/repo/b.ts");
	});

	test("lets the later refresh of a link win when the earlier one finishes last", async () => {
		const { host, requests } = deferredHost();

		// The earlier refresh saw `foo.ts` missing; a tool then created it.
		const earlier = refreshAssistantMessageLinkTargets(host, [reply("See [foo](foo.ts).")]);
		const later = refreshAssistantMessageLinkTargets(host, [reply("Created [foo](foo.ts).")]);
		requests[1]!.resolve(new Map([["foo.ts", "/repo/foo.ts"]]));
		await later;
		requests[0]!.resolve(new Map());
		await earlier;

		expect(getAssistantMessageLinkTargets(host).get("foo.ts")).toBe("/repo/foo.ts");
	});
});

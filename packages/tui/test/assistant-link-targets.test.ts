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

describe("refreshAssistantMessageLinkTargets", () => {
	test("keeps links committed by a concurrent refresh that resolved first", async () => {
		const pending = new Map<string, PromiseWithResolvers<ReadonlyMap<string, string>>>();
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
			resolveAssistantMessageLinkHrefs(hrefs) {
				const resolver = Promise.withResolvers<ReadonlyMap<string, string>>();
				pending.set(hrefs.join(","), resolver);
				return resolver.promise;
			},
		};

		// A wider transcript redraw and a just-finished reply resolve their links concurrently.
		const redraw = refreshAssistantMessageLinkTargets(host, [reply("Older note in [a](a.ts).")]);
		const finished = refreshAssistantMessageLinkTargets(host, [reply("New note in [b](b.ts).")]);
		pending.get("b.ts")!.resolve(new Map([["b.ts", "/repo/b.ts"]]));
		await finished;
		pending.get("a.ts")!.resolve(new Map([["a.ts", "/repo/a.ts"]]));
		await redraw;

		const targets = getAssistantMessageLinkTargets(host);
		expect(targets.get("a.ts")).toBe("/repo/a.ts");
		expect(targets.get("b.ts")).toBe("/repo/b.ts");
	});
});

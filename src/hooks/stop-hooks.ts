import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHookGroups } from "../config";
import { extractTextFromContent } from "../helpers";
import type { HookModuleContext } from "../hook-context";
import type {
  HookExecutionContext,
  NotifyFn,
  SettingsFile,
  StopResult,
} from "../types";
import {
  appendAdditionalContext,
  executeParsedHook,
  getStringField,
  hookIfMatches,
} from "./shared";

function findLastAssistantMessage(messages: unknown[]): {
  text: string;
  stopReason?: string;
  errorMessage?: string;
} | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {
      role?: string;
      content?: unknown;
      stopReason?: string;
      errorMessage?: string;
    };

    if (message?.role === "assistant") {
      return {
        text: extractTextFromContent(message.content),
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
      };
    }
  }

  return undefined;
}

export async function triggerStopHooks(
  eventName: "Stop" | "StopFailure",
  context: HookExecutionContext,
  settings: SettingsFile | undefined,
  notify?: NotifyFn,
): Promise<StopResult> {
  const groups = getHookGroups(settings, eventName);
  const result: StopResult = { blocked: false };

  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (hook.if && !hookIfMatches(context, hook.if)) continue;

      try {
        const { hookResult, plainStdout, jsonOutput, commonOutput } =
          await executeParsedHook(hook, context, eventName);

        if (hookResult.exitCode === 0 && jsonOutput) {
          const additionalContext = getStringField(
            commonOutput?.hookSpecificOutput?.additionalContext,
            jsonOutput.additionalContext,
          );

          result.additionalContext = appendAdditionalContext(
            result.additionalContext,
            additionalContext,
          );

          if (commonOutput?.systemMessage) {
            notify?.(commonOutput.systemMessage, "warning");
          }

          if (
            jsonOutput.decision !== undefined &&
            jsonOutput.decision !== "block"
          ) {
            notify?.(
              `${eventName} 忽略无效 decision: ${String(jsonOutput.decision)}`,
              "warning",
            );
          }

          if (jsonOutput.decision === "block") {
            result.blocked = true;
            result.reason =
              getStringField(jsonOutput.reason) ??
              "Continue requested by hook";
            return result;
          }
        } else if (hookResult.exitCode === 0 && plainStdout) {
          notify?.(`${eventName} 输出 (非JSON): ${plainStdout}`, "info");
        }

        if (hookResult.exitCode !== 0) {
          notify?.(
            `${eventName} 失败 (exit ${hookResult.exitCode}): ${hookResult.stderr}`,
            "error",
          );
        }
      } catch (err) {
        notify?.(`${eventName} 执行错误: ${String(err)}`, "error");
      }
    }
  }

  return result;
}

export function registerStopHooks(pi: ExtensionAPI, shared: HookModuleContext) {
  pi.on("agent_end", async (event, ctx) => {
    const lastAssistant = findLastAssistantMessage(event.messages);
    // agent 失败时最后一条 assistant 消息的 stopReason 为 "error"，
    // 此时触发 StopFailure，否则触发 Stop。
    const eventName: "Stop" | "StopFailure" =
      lastAssistant?.stopReason === "error" ? "StopFailure" : "Stop";

    const result = await triggerStopHooks(
      eventName,
      {
        sessionId: shared.getSessionId(ctx),
        cwd: ctx.cwd,
        hookEventName: eventName,
        transcriptPath: ctx.sessionManager.getSessionFile(),
        stopHookActive: shared.stopHookActive,
        lastAssistantMessage: lastAssistant?.text ?? "",
        errorMessage: lastAssistant?.errorMessage,
      },
      shared.currentSettings,
      (msg, type) => shared.notify(ctx, msg, type),
    );

    if (result.blocked) {
      const continuationMessage = [result.reason, result.additionalContext]
        .filter((value): value is string => Boolean(value && value.trim()))
        .join("\n\n");

      shared.stopHookActive = true;
      shared.pi.sendMessage(
        {
          customType: "pi-hooks",
          content: continuationMessage,
          display: false,
          details: {
            hookEventName: eventName,
            stopHookActive: true,
          },
        },
        {
          deliverAs: "followUp",
          triggerTurn: true,
        },
      );
      return;
    }

    shared.stopHookActive = false;
  });
}

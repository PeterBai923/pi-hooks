import { spawn } from "node:child_process";
import type { Hook, HookExecutionContext } from "./types";

// ============================================================================
// Hook 执行器
// ============================================================================

/**
 * 构建 Claude Code 风格的 JSON 输入
 */
export function buildHookInput(ctx: HookExecutionContext): object {
  const base: Record<string, unknown> = {
    session_id: ctx.sessionId,
    cwd: ctx.cwd,
    hook_event_name: ctx.hookEventName,
    transcript_path: ctx.transcriptPath,
  };

  if (ctx.hookEventName === "PreCompact") {
    return {
      ...base,
      trigger: ctx.trigger,
      custom_instructions: ctx.customInstructions ?? "",
    };
  }

  if (ctx.hookEventName === "PostCompact") {
    return {
      ...base,
      trigger: ctx.trigger,
      compact_summary: ctx.compactSummary,
    };
  }

  if (ctx.hookEventName === "UserPromptSubmit") {
    return {
      ...base,
      prompt: ctx.prompt,
    };
  }

  if (ctx.hookEventName === "Stop") {
    return {
      ...base,
      stop_hook_active: ctx.stopHookActive ?? false,
      last_assistant_message: ctx.lastAssistantMessage ?? "",
    };
  }

  if (
    ctx.hookEventName === "PreToolUse" ||
    ctx.hookEventName === "PostToolUse" ||
    ctx.hookEventName === "PostToolUseFailure"
  ) {
    const toolInput: Record<string, unknown> = {
      ...base,
      tool_name: ctx.toolName,
      tool_input: ctx.toolInput,
      tool_use_id: ctx.toolUseId,
    };

    if (ctx.hookEventName === "PostToolUse") {
      toolInput.tool_response = ctx.toolResponse;
    }

    if (ctx.hookEventName === "PostToolUseFailure") {
      toolInput.error = ctx.error;
      if (ctx.isInterrupt !== undefined) {
        toolInput.is_interrupt = ctx.isInterrupt;
      }
    }

    return toolInput;
  }

  if (ctx.hookEventName === "SessionEnd") {
    return {
      ...base,
      reason: ctx.reason,
      model: ctx.model,
    };
  }

  return {
    ...base,
    source: ctx.source,
    model: ctx.model,
  };
}

export async function executeHook(
  hook: Hook,
  input: object,
  cwd: string,
  timeoutMs: number = 60000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const inputJson = JSON.stringify(input);

  // type 省略时按 command 处理（兼容无 type 字段的旧配置）
  if (hook.type === "http" && hook.url) {
    return executeHttpHook(hook.url, hook.headers, inputJson, timeoutMs);
  }

  if (!hook.command) {
    return {
      stdout: "",
      stderr: "[pi-hooks] Hook 缺少 command 字段",
      exitCode: 1,
    };
  }

  return executeCommandHook(hook.command, inputJson, cwd, timeoutMs);
}

/**
 * HTTP hook：向 url 发送 POST JSON 请求，
 * 响应体按 command hook 的 stdout 处理（解析为 JSON 输出）。
 */
function executeHttpHook(
  url: string,
  headers: Record<string, string> | undefined,
  inputJson: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(headers ?? {}),
      },
      body: inputJson,
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = await res.text();
        clearTimeout(timer);
        if (!res.ok) {
          resolve({
            stdout: "",
            stderr: body ? `HTTP ${res.status}: ${body}` : `HTTP ${res.status}`,
            exitCode: 1,
          });
        } else {
          resolve({ stdout: body, stderr: "", exitCode: 0 });
        }
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        const aborted = err instanceof Error && err.name === "AbortError";
        resolve({
          stdout: "",
          stderr: aborted
            ? "[pi-hooks] Hook timed out"
            : `HTTP 请求失败: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
        });
      });
  });
}

function executeCommandHook(
  command: string,
  inputJson: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: { stdout: string; stderr: string; exitCode: number }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.stdin.write(inputJson);
    child.stdin.end();

    const timeout = setTimeout(() => {
      child.kill();
      finish({
        stdout,
        stderr: `${stderr}\n[pi-hooks] Hook timed out`.trim(),
        exitCode: 1,
      });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timeout);
      finish({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      finish({
        stdout,
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

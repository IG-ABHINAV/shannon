// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

// Codex CLI agent execution with retry, git checkpoints, and audit logging

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk, { type ChalkInstance } from 'chalk';

import { isRetryableError, getRetryDelay, PentestError } from '../error-handling.js';
import { timingResults, Timer } from '../utils/metrics.js';
import { formatTimestamp } from '../utils/formatting.js';
import {
  createGitCheckpoint,
  commitGitSuccess,
  rollbackGitWorkspace,
  getGitCommitHash,
} from '../utils/git-manager.js';
import { AGENT_VALIDATORS, MCP_AGENT_MAPPING } from '../constants.js';
import { AuditSession } from '../audit/index.js';
import type { SessionMetadata } from '../audit/utils.js';
import { getPromptNameForAgent } from '../types/agents.js';
import type { AgentName } from '../types/index.js';

import {
  detectExecutionContext,
  formatAssistantOutput,
  formatCompletionMessage,
  formatErrorOutput,
  formatToolResultOutput,
  formatToolUseOutput,
} from './output-formatters.js';
import { createProgressManager } from './progress-manager.js';
import { createAuditLogger } from './audit-logger.js';

declare global {
  var SHANNON_DISABLE_LOADER: boolean | undefined;
}

export interface CodexPromptResult {
  result?: string | null | undefined;
  success: boolean;
  duration: number;
  turns?: number | undefined;
  cost: number;
  model?: string | undefined;
  partialCost?: number | undefined;
  apiErrorDetected?: boolean | undefined;
  error?: string | undefined;
  errorType?: string | undefined;
  prompt?: string | undefined;
  retryable?: boolean | undefined;
}

export type ClaudePromptResult = CodexPromptResult;

interface CodexRuntime {
  args: string[];
  command: string;
  cleanup: () => Promise<void>;
  env: NodeJS.ProcessEnv;
  lastMessagePath: string;
  model: string;
}

function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

interface ParsedUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

interface CodexStreamState {
  agentMessages: string[];
  turnCount: number;
  usage: ParsedUsage | null;
  model: string;
  stderr: string[];
}

function outputLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

function getCodexModel(): string {
  return process.env.SHANNON_CODEX_MODEL || 'gpt-5.4';
}

function getReasoningEffort(): string {
  return process.env.SHANNON_CODEX_REASONING_EFFORT || 'high';
}

function resolveCodexLaunch(): { command: string; prefixArgs: string[] } {
  if (process.env.SHANNON_CODEX_BIN) {
    return { command: process.env.SHANNON_CODEX_BIN, prefixArgs: [] };
  }

  const localScript = path.join(
    process.cwd(),
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js'
  );

  if (existsSync(localScript)) {
    return { command: process.execPath, prefixArgs: [localScript] };
  }

  return {
    command: process.platform === 'win32' ? 'codex.cmd' : 'codex',
    prefixArgs: [],
  };
}

function resolveCodexAuthHome(): string {
  const candidates = [
    process.env.SHANNON_CODEX_AUTH_HOME,
    process.env.CODEX_HOME,
    path.join(os.homedir(), '.codex'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] || path.join(os.homedir(), '.codex');
}

async function copyCodexAuthFiles(sourceDir: string, targetDir: string): Promise<void> {
  const filesToCopy = [
    'auth.json',
    'cap_sid',
    '.codex-global-state.json',
    'models_cache.json',
    'version.json',
  ];

  for (const file of filesToCopy) {
    const sourcePath = path.join(sourceDir, file);
    const targetPath = path.join(targetDir, file);

    if (existsSync(sourcePath)) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function buildPlaywrightSection(sourceDir: string, agentName: string | null): string[] {
  if (!agentName) {
    return [];
  }

  const promptName = getPromptNameForAgent(agentName as AgentName);
  const playwrightMcpName =
    MCP_AGENT_MAPPING[promptName as keyof typeof MCP_AGENT_MAPPING] || null;

  if (!playwrightMcpName) {
    return [];
  }

  const userDataDir = path.join(
    os.tmpdir(),
    `${playwrightMcpName}-${process.pid}-${Date.now()}`
  );

  const args = [
    '@playwright/mcp@latest',
    '--isolated',
    '--user-data-dir',
    userDataDir,
  ];

  if (process.env.SHANNON_DOCKER === 'true') {
    args.push('--browser', 'chromium');
    args.push('--executable-path', '/usr/bin/chromium-browser');
  }

  return [
    '',
    `[mcp_servers.${playwrightMcpName}]`,
    `command = ${tomlString('npx')}`,
    `args = ${tomlArray(args)}`,
    'startup_timeout_sec = 30',
  ];
}

function buildCodexConfig(sourceDir: string, agentName: string | null): string {
  const helperScript = path.join(
    import.meta.dirname,
    '..',
    '..',
    'mcp-server',
    'dist',
    'index.js'
  );

  const lines = [
    `model = ${tomlString(getCodexModel())}`,
    `model_reasoning_effort = ${tomlString(getReasoningEffort())}`,
    '',
    `[projects.${tomlString(sourceDir)}]`,
    `trust_level = ${tomlString('trusted')}`,
    '',
    '[mcp_servers.shannon-helper]',
    `command = ${tomlString(process.execPath)}`,
    `args = ${tomlArray([helperScript, '--target-dir', sourceDir])}`,
    'startup_timeout_sec = 15',
    ...buildPlaywrightSection(sourceDir, agentName),
  ];

  return `${lines.join('\n')}\n`;
}

async function createCodexRuntime(
  sourceDir: string,
  agentName: string | null
): Promise<CodexRuntime> {
  const authHome = resolveCodexAuthHome();
  const authFile = path.join(authHome, 'auth.json');

  if (!existsSync(authFile)) {
    throw new PentestError(
      `Codex authentication not found at ${authFile}. Run \`codex login\` before starting Shannon.`,
      'config',
      false,
      { authHome }
    );
  }

  const runtimeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'shannon-codex-'));
  const lastMessagePath = path.join(runtimeHome, 'last-message.txt');
  const launch = resolveCodexLaunch();

  await copyCodexAuthFiles(authHome, runtimeHome);
  await fs.writeFile(path.join(runtimeHome, 'config.toml'), buildCodexConfig(sourceDir, agentName), 'utf8');

  const args = [
    ...launch.prefixArgs,
    'exec',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--cd',
    sourceDir,
    '--output-last-message',
    lastMessagePath,
    '-m',
    getCodexModel(),
    '-',
  ];

  const cleanup = async (): Promise<void> => {
    await fs.rm(runtimeHome, { recursive: true, force: true });
  };

  return {
    args,
    command: launch.command,
    cleanup,
    env: {
      ...sanitizeEnv(process.env),
      CODEX_HOME: runtimeHome,
    },
    lastMessagePath,
    model: getCodexModel(),
  };
}

async function cleanupRuntime(runtime: CodexRuntime): Promise<void> {
  try {
    await runtime.cleanup();
  } catch {}
}

function shouldIgnoreStderrLine(line: string): boolean {
  const noisyPatterns = [
    'failed to open state db',
    'failed to initialize state runtime',
    'shell snapshot not supported yet for powershell',
  ];

  const lower = line.toLowerCase();
  return noisyPatterns.some((pattern) => lower.includes(pattern));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function getFirstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function extractToolEvent(record: Record<string, unknown>): { toolName: string; payload: unknown } {
  const item = asRecord(record.item) || record;
  const toolName =
    getFirstString(item, ['tool_name', 'toolName', 'name', 'server_name', 'serverName']) ||
    getFirstString(record, ['tool_name', 'toolName', 'name']) ||
    'tool';

  const payload =
    item.arguments ??
    item.input ??
    item.params ??
    record.arguments ??
    record.input ??
    record.params ??
    {};

  return { toolName, payload };
}

function extractToolResult(record: Record<string, unknown>): unknown {
  const item = asRecord(record.item) || record;

  return (
    item.result ??
    item.output ??
    record.result ??
    record.output ??
    record.error ??
    {}
  );
}

function extractAgentMessage(record: Record<string, unknown>): string | null {
  const item = asRecord(record.item);
  if (!item) {
    return null;
  }

  if (item.type === 'agent_message' && typeof item.text === 'string') {
    return item.text;
  }

  const content = Array.isArray(item.content) ? item.content : null;
  if (!content) {
    return null;
  }

  const text = content
    .map((entry) => {
      const block = asRecord(entry);
      return block && typeof block.text === 'string' ? block.text : null;
    })
    .filter((entry): entry is string => Boolean(entry))
    .join('\n')
    .trim();

  return text || null;
}

function createCodexError(message: string): Error {
  const lower = message.toLowerCase();

  if (
    lower.includes('usage limit') ||
    lower.includes('quota') ||
    lower.includes('upgrade to plus') ||
    lower.includes('insufficient credits')
  ) {
    return new PentestError(message, 'billing', true);
  }

  if (
    lower.includes('authentication') ||
    lower.includes('not logged in') ||
    lower.includes('codex authentication not found')
  ) {
    return new PentestError(message, 'config', false);
  }

  return new Error(message);
}

async function handleJsonEvent(
  rawLine: string,
  state: CodexStreamState,
  deps: {
    execContext: ReturnType<typeof detectExecutionContext>;
    description: string;
    colorFn: ChalkInstance;
    progress: ReturnType<typeof createProgressManager>;
    auditLogger: ReturnType<typeof createAuditLogger>;
  }
): Promise<Error | null> {
  const event = JSON.parse(rawLine) as Record<string, unknown>;
  const type = typeof event.type === 'string' ? event.type : '';
  const { execContext, description, colorFn, progress, auditLogger } = deps;

  if (type === 'turn.completed') {
    state.turnCount += 1;
    state.usage = asRecord(event.usage) as ParsedUsage | null;
    return null;
  }

  if (type === 'error') {
    const message = getFirstString(event, ['message']) || 'Codex CLI returned an unknown error';
    return createCodexError(message);
  }

  if (type === 'turn.failed') {
    const errorRecord = asRecord(event.error) || event;
    const message = getFirstString(errorRecord, ['message']) || 'Codex turn failed';
    return createCodexError(message);
  }

  if (type === 'item.started' || type === 'mcp_tool_call_begin' || type === 'exec_command_begin') {
    const { toolName, payload } = extractToolEvent(event);
    outputLines(formatToolUseOutput(toolName, asRecord(payload) || undefined));
    await auditLogger.logToolStart(toolName, payload);
    return null;
  }

  if (type === 'item.completed' || type === 'mcp_tool_call_end' || type === 'exec_command_end') {
    const message = extractAgentMessage(event);
    if (message) {
      state.agentMessages.push(message);
      progress.stop();
      outputLines(
        formatAssistantOutput(
          message,
          execContext,
          Math.max(state.turnCount, state.agentMessages.length),
          description,
          colorFn
        )
      );
      progress.start();
      await auditLogger.logLlmResponse(Math.max(state.turnCount, state.agentMessages.length), message);
      return null;
    }

    const result = extractToolResult(event);
    outputLines(formatToolResultOutput(JSON.stringify(result, null, 2)));
    await auditLogger.logToolEnd(result);
    return null;
  }

  return null;
}

async function processCodexExec(
  fullPrompt: string,
  runtime: CodexRuntime,
  deps: {
    execContext: ReturnType<typeof detectExecutionContext>;
    description: string;
    colorFn: ChalkInstance;
    progress: ReturnType<typeof createProgressManager>;
    auditLogger: ReturnType<typeof createAuditLogger>;
  }
): Promise<{ result: string | null; turns: number; model: string; stderr: string[] }> {
  const state: CodexStreamState = {
    agentMessages: [],
    turnCount: 0,
    usage: null,
    model: runtime.model,
    stderr: [],
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(runtime.command, runtime.args, {
      env: runtime.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let stdoutChain = Promise.resolve();

    const flushStdout = (final: boolean): Promise<void> => {
      const parts = stdoutBuffer.split(/\r?\n/);
      if (!final) {
        stdoutBuffer = parts.pop() ?? '';
      } else {
        stdoutBuffer = '';
      }

      for (const part of parts) {
        const line = part.trim();
        if (!line) {
          continue;
        }

        stdoutChain = stdoutChain.then(async () => {
          const error = await handleJsonEvent(line, state, deps);
          if (error) {
            reject(error);
            child.kill();
          }
        });
      }

      return stdoutChain;
    };

    const flushStderr = (final: boolean): void => {
      const parts = stderrBuffer.split(/\r?\n/);
      if (!final) {
        stderrBuffer = parts.pop() ?? '';
      } else {
        stderrBuffer = '';
      }

      for (const part of parts) {
        const line = part.trim();
        if (!line || shouldIgnoreStderrLine(line)) {
          continue;
        }
        state.stderr.push(line);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      void flushStdout(false);
    });

    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk;
      flushStderr(false);
    });

    child.on('error', reject);

    child.on('close', async (code) => {
      await flushStdout(true);
      flushStderr(true);

      if (code !== 0) {
        const detail = state.stderr[0] || 'Codex CLI exited unsuccessfully';
        reject(createCodexError(detail));
        return;
      }

      resolve();
    });

    child.stdin.end(fullPrompt, 'utf8');
  });

  let result: string | null = null;
  try {
    const lastMessage = await fs.readFile(runtime.lastMessagePath, 'utf8');
    result = lastMessage.trim() || null;
  } catch {
    result = null;
  }

  if (!result && state.agentMessages.length > 0) {
    result = state.agentMessages[state.agentMessages.length - 1] || null;
  }

  return {
    result,
    turns: state.turnCount || state.agentMessages.length,
    model: state.model,
    stderr: state.stderr,
  };
}

async function writeErrorLog(
  err: Error & { code?: string; status?: number },
  sourceDir: string,
  fullPrompt: string,
  duration: number
): Promise<void> {
  try {
    const errorLog = {
      timestamp: formatTimestamp(),
      agent: 'codex-executor',
      error: {
        name: err.constructor.name,
        message: err.message,
        code: err.code,
        status: err.status,
        stack: err.stack,
      },
      context: {
        sourceDir,
        prompt: `${fullPrompt.slice(0, 200)}...`,
        retryable: isRetryableError(err),
      },
      duration,
    };
    const logPath = path.join(sourceDir, 'error.log');
    await fs.appendFile(logPath, `${JSON.stringify(errorLog)}\n`);
  } catch (logError) {
    const logErrMsg = logError instanceof Error ? logError.message : String(logError);
    console.log(chalk.gray(`    (Failed to write error log: ${logErrMsg})`));
  }
}

export async function validateAgentOutput(
  result: CodexPromptResult,
  agentName: string | null,
  sourceDir: string
): Promise<boolean> {
  console.log(chalk.blue(`    Validating ${agentName} agent output`));

  try {
    if (!result.success || !result.result) {
      console.log(chalk.red('    Validation failed: Agent execution was unsuccessful'));
      return false;
    }

    const validator = agentName
      ? AGENT_VALIDATORS[agentName as keyof typeof AGENT_VALIDATORS]
      : undefined;

    if (!validator) {
      console.log(chalk.yellow(`    No validator found for agent "${agentName}" - assuming success`));
      console.log(chalk.green('    Validation passed: Unknown agent with successful result'));
      return true;
    }

    const validationResult = await validator(sourceDir);

    if (validationResult) {
      console.log(chalk.green('    Validation passed: Required files/structure present'));
    } else {
      console.log(chalk.red('    Validation failed: Missing required deliverable files'));
    }

    return validationResult;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`    Validation failed with error: ${errMsg}`));
    return false;
  }
}

export async function runCodexPrompt(
  prompt: string,
  sourceDir: string,
  context: string = '',
  description: string = 'Codex analysis',
  agentName: string | null = null,
  colorFn: ChalkInstance = chalk.cyan,
  _sessionMetadata: SessionMetadata | null = null,
  auditSession: AuditSession | null = null,
  _attemptNumber: number = 1
): Promise<CodexPromptResult> {
  const timer = new Timer(`agent-${description.toLowerCase().replace(/\s+/g, '-')}`);
  const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;

  const execContext = detectExecutionContext(description);
  const progress = createProgressManager(
    { description, useCleanOutput: execContext.useCleanOutput },
    global.SHANNON_DISABLE_LOADER ?? false
  );
  const auditLogger = createAuditLogger(auditSession);

  console.log(chalk.blue(`  Running Codex CLI: ${description}...`));

  progress.start();

  try {
    const runtime = await createCodexRuntime(sourceDir, agentName);

    try {
      const execution = await processCodexExec(fullPrompt, runtime, {
        execContext,
        description,
        colorFn,
        progress,
        auditLogger,
      });

      const duration = timer.stop();
      timingResults.agents[execContext.agentKey] = duration;

      progress.finish(formatCompletionMessage(execContext, description, execution.turns, duration));

      return {
        result: execution.result,
        success: true,
        duration,
        turns: execution.turns,
        cost: 0,
        model: execution.model,
        partialCost: 0,
        apiErrorDetected: false,
      };
    } finally {
      await cleanupRuntime(runtime);
    }
  } catch (error) {
    const duration = timer.stop();
    timingResults.agents[execContext.agentKey] = duration;

    const err = error as Error & { code?: string; status?: number };

    await auditLogger.logError(err, duration, 0);
    progress.stop();
    outputLines(formatErrorOutput(err, execContext, description, duration, sourceDir, isRetryableError(err)));
    await writeErrorLog(err, sourceDir, fullPrompt, duration);

    return {
      error: err.message,
      errorType: err.constructor.name,
      prompt: `${fullPrompt.slice(0, 100)}...`,
      success: false,
      duration,
      cost: 0,
      retryable: isRetryableError(err),
      model: getCodexModel(),
    };
  }
}

export async function runCodexPromptWithRetry(
  prompt: string,
  sourceDir: string,
  _allowedTools: string = 'Read',
  context: string = '',
  description: string = 'Codex analysis',
  agentName: string | null = null,
  colorFn: ChalkInstance = chalk.cyan,
  sessionMetadata: SessionMetadata | null = null
): Promise<CodexPromptResult> {
  const maxRetries = 3;
  let lastError: Error | undefined;
  let retryContext = context;

  console.log(chalk.cyan(`Starting ${description} with ${maxRetries} max attempts`));

  let auditSession: AuditSession | null = null;
  if (sessionMetadata && agentName) {
    auditSession = new AuditSession(sessionMetadata);
    await auditSession.initialize();
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await createGitCheckpoint(sourceDir, description, attempt);

    if (auditSession && agentName) {
      const fullPrompt = retryContext ? `${retryContext}\n\n${prompt}` : prompt;
      await auditSession.startAgent(agentName, fullPrompt, attempt);
    }

    try {
      const result = await runCodexPrompt(
        prompt,
        sourceDir,
        retryContext,
        description,
        agentName,
        colorFn,
        sessionMetadata,
        auditSession,
        attempt
      );

      if (!result.success) {
        const executionError = new PentestError(
          result.error || `${description} failed`,
          'prompt',
          result.retryable ?? false,
          {
            description,
            sourceDir,
            errorType: result.errorType,
            model: result.model,
          }
        ) as PentestError & { duration?: number; cost?: number };

        executionError.duration = result.duration;
        executionError.cost = result.cost || 0;
        throw executionError;
      }

      const validationPassed = await validateAgentOutput(result, agentName, sourceDir);

      if (validationPassed) {
        if (auditSession && agentName) {
          const commitHash = await getGitCommitHash(sourceDir);
          const endResult: {
            attemptNumber: number;
            duration_ms: number;
            cost_usd: number;
            success: true;
            checkpoint?: string;
          } = {
            attemptNumber: attempt,
            duration_ms: result.duration,
            cost_usd: result.cost || 0,
            success: true,
          };

          if (commitHash) {
            endResult.checkpoint = commitHash;
          }

          await auditSession.endAgent(agentName, endResult);
        }

        await commitGitSuccess(sourceDir, description);
        console.log(chalk.green.bold(`${description} completed successfully on attempt ${attempt}/${maxRetries}`));
        return result;
      }

      console.log(chalk.yellow(`${description} completed but output validation failed`));

      if (auditSession && agentName) {
        await auditSession.endAgent(agentName, {
          attemptNumber: attempt,
          duration_ms: result.duration,
          cost_usd: result.partialCost || result.cost || 0,
          success: false,
          error: 'Output validation failed',
          isFinalAttempt: attempt === maxRetries,
        });
      }

      lastError = new Error('Output validation failed');

      if (attempt < maxRetries) {
        await rollbackGitWorkspace(sourceDir, 'validation failure');
        continue;
      }

      throw new PentestError(
        `Agent ${description} failed output validation after ${maxRetries} attempts. Required deliverable files were not created.`,
        'validation',
        false,
        { description, sourceDir, attemptsExhausted: maxRetries }
      );
    } catch (error) {
      const err = error as Error & { duration?: number; cost?: number; partialResults?: unknown };
      lastError = err;

      if (auditSession && agentName) {
        await auditSession.endAgent(agentName, {
          attemptNumber: attempt,
          duration_ms: err.duration || 0,
          cost_usd: err.cost || 0,
          success: false,
          error: err.message,
          isFinalAttempt: attempt === maxRetries,
        });
      }

      if (!isRetryableError(err)) {
        console.log(chalk.red(`${description} failed with non-retryable error: ${err.message}`));
        await rollbackGitWorkspace(sourceDir, 'non-retryable error cleanup');
        throw err;
      }

      if (attempt < maxRetries) {
        await rollbackGitWorkspace(sourceDir, 'retryable error cleanup');

        const delay = getRetryDelay(err, attempt);
        const delaySeconds = (delay / 1000).toFixed(1);
        console.log(chalk.yellow(`${description} failed (attempt ${attempt}/${maxRetries})`));
        console.log(chalk.gray(`    Error: ${err.message}`));
        console.log(chalk.gray(`    Workspace rolled back, retrying in ${delaySeconds}s...`));

        if (err.partialResults) {
          retryContext = `${context}\n\nPrevious partial results: ${JSON.stringify(err.partialResults)}`;
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        await rollbackGitWorkspace(sourceDir, 'final failure cleanup');
        console.log(chalk.red(`${description} failed after ${maxRetries} attempts`));
        console.log(chalk.red(`    Final error: ${err.message}`));
      }
    }
  }

  throw lastError;
}

export const runClaudePrompt = runCodexPrompt;
export const runClaudePromptWithRetry = runCodexPromptWithRetry;

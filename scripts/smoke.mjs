#!/usr/bin/env node
/**
 * End-to-end проверка: поднимает сервер как MCP-клиент и прогоняет инструменты.
 *
 * Запуск:
 *   node scripts/smoke.mjs               — полный прогон, включая реальный вызов Claude Code
 *   node scripts/smoke.mjs --no-live     — только проверки, не тратящие токены
 *
 * Требует авторизованного Claude Code: claude auth login
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HOOK_TIMEOUT_MARGIN_SECONDS, HookBridge } from "../dist/hookBridge.js";
import { isReadOnlyCommand } from "../dist/readOnlyCommand.js";
import { waitForJob } from "../dist/jobs.js";
import { isValidBranchName } from "../dist/gitOps.js";
import { detectPatterns, diagnose } from "../dist/diagnose.js";
import { detectOpenQuestions, parseClaudeOutput } from "../dist/parser.js";
import { JobProgress } from "../dist/progress.js";
import {
  buildStreamDriftHint,
  buildTerminalHint,
  progressLogFields,
  toProgressView,
} from "../dist/progressView.js";
import { buildHookSettings, ClaudeRunner } from "../dist/runner.js";
import { EXECUTE_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT } from "../dist/prompts.js";
import {
  MAX_EVENT_LINE_CHARS,
  MAX_STDERR_TAIL,
  MAX_STDOUT_TAIL,
  NdjsonSplitter,
} from "../dist/stream.js";
import { SessionRegistry } from "../dist/sessions.js";
import {
  diffWindowsPath,
  expandWindowsVars,
  isNested,
  joinWindowsPath,
  keepPwshPackageDir,
  markNested,
  NESTED_ENV_VAR,
  pathKey,
  scrubEnv,
} from "../dist/env.js";
import { resolveProjectEntry, resolveProjectFile } from "../dist/paths.js";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = !process.argv.includes("--no-live");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
    passed++;
  } else {
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
    failed++;
  }
}

function report(result) {
  return JSON.parse(result.content[0].text);
}

const workspace = mkdtempSync(join(tmpdir(), "ccc-mcp-smoke-"));
const projectDir = join(workspace, "project");
mkdirSync(projectDir);
writeFileSync(join(projectDir, "README.md"), "# smoke test project\n");

/**
 * Ищет пригодный для spawn бинарь claude.
 *
 * Тест поднимает сервер со своим временным конфигом, поэтому claudeBin из
 * рабочего ccc-mcp.config.json сюда не попадает, а голое "claude" годится
 * не всегда: при npm-установке в PATH лежат только обёртки claude.cmd/.ps1,
 * которые мост отклоняет намеренно (им нужен shell: true), и spawn с
 * shell: false даёт ENOENT. Порядок: явный CCC_CLAUDE_BIN → claudeBin из
 * рабочего конфига → PATH → бинарь, забандленный в npm-пакет.
 */
function findClaudeBin() {
  const fromEnv = process.env.CCC_CLAUDE_BIN?.trim();
  if (fromEnv) return fromEnv;

  const workingConfig = join(root, "ccc-mcp.config.json");
  if (existsSync(workingConfig)) {
    try {
      // Конфиг — JSONC, комментарии перед разбором убираем.
      const text = readFileSync(workingConfig, "utf8").replace(/^\s*\/\/.*$/gm, "");
      const bin = JSON.parse(text).claudeBin;
      if (typeof bin === "string" && bin.trim() && bin.trim() !== "claude") {
        return bin.trim();
      }
    } catch {
      // Битый рабочий конфиг не должен ронять тест — идём дальше по списку.
    }
  }

  // "claude" проверяем через PATH, остальных кандидатов — по существованию файла.
  const candidates = ["claude"];
  if (process.env.APPDATA) {
    candidates.push(
      join(process.env.APPDATA, "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
    );
  }
  if (process.env.USERPROFILE) {
    candidates.push(join(process.env.USERPROFILE, ".local/bin/claude.exe"));
  }
  if (process.env.HOME) {
    candidates.push(join(process.env.HOME, ".local/bin/claude"));
  }

  for (const candidate of candidates) {
    if (candidate !== "claude" && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 20000,
    });
    if (!probe.error) return candidate;
  }
  return "claude"; // не нашли — пусть сервер сам скажет об этом внятно
}

const claudeBin = findClaudeBin();

const configPath = join(workspace, "ccc-mcp.config.json");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      allowedRoots: [workspace],
      claudeBin,
      timeoutMs: 300000,
      defaultWaitSeconds: 0,
      logFile: join(workspace, "logs", "ccc-mcp.jsonl"),
      // Нарочито маленький, чтобы обрезка диффа проверялась без гигантских файлов.
      maxDiffBytes: 2048,
    },
    null,
    2,
  ),
);

console.log(`Временный проект: ${projectDir}`);
console.log(`claudeBin: ${claudeBin}\n`);

// Без метки вложенности: smoke — канонический вызов, и его запускает в том числе
// дочерний claude внутри execute_task. Унаследованная метка уронила бы сервер
// на старте, хотя здесь он нужен как объект проверки, а не как инструмент ребёнка.
const serverEnv = { ...process.env, CCC_MCP_CONFIG: configPath };
delete serverEnv[NESTED_ENV_VAR];

const client = new Client({ name: "ccc-mcp-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "index.js")],
  env: serverEnv,
  stderr: "inherit",
});

try {
  await client.connect(transport);
  console.log("1. Подключение и список инструментов");

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check(
    "зарегистрированы 12 инструментов",
    names.join(",") ===
      "approve_permission_request,approve_plan,cancel_task,execute_task,get_bridge_info," +
        "get_task_status,list_project_files,list_tasks,plan_task,read_project_file,run_git," +
        "write_project_file",
    `получено: ${names.join(", ")}`,
  );

  // Версия сервера читается из package.json во время выполнения — проверка ловит
  // возврат к хардкоду, при котором bump версии перестал бы доезжать до клиента.
  const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const serverInfo = client.getServerVersion();
  check(
    "сервер объявляет версию из package.json",
    serverInfo?.version === pkgVersion,
    `сервер: ${serverInfo?.version}, package.json: ${pkgVersion}`,
  );

  {
    const infoRes = await client.callTool({ name: "get_bridge_info", arguments: {} });
    const info = JSON.parse(infoRes.content[0].text);
    const raw = infoRes.content[0].text;
    check(
      "get_bridge_info: версия из package.json, время старта и версия claude",
      info.server?.version === pkgVersion &&
        typeof info.server.server_started_at === "string" &&
        typeof info.server.claude_version === "string",
      JSON.stringify(info.server),
    );
    check(
      "get_bridge_info: таймаут, ожидание и параллельность из конфига",
      info.tasks?.timeout_minutes === 5 &&
        info.tasks.default_wait_seconds === 0 &&
        info.tasks.max_wait_seconds === 120 &&
        typeof info.tasks.max_concurrent === "number",
      JSON.stringify(info.tasks),
    );
    check(
      "get_bridge_info: при выключенных хуках раздел разрешений без подробностей",
      info.permissions?.hooks_enabled === false &&
        info.permissions.operator_absent_minutes === undefined &&
        info.permissions.auto_approve_commands === undefined,
      JSON.stringify(info.permissions),
    );
    check(
      "get_bridge_info: допустимые каталоги и лимиты файлов",
      Array.isArray(info.files?.allowed_roots) &&
        info.files.allowed_roots.length === 1 &&
        typeof info.files.max_file_bytes === "number" &&
        info.git?.max_diff_bytes === 2048,
      JSON.stringify({ files: info.files, git: info.git }),
    );
    check(
      "get_bridge_info не раскрывает passEnv, путь к логу и путь к claude",
      !/passEnv|pass_env|log_file|logFile|claude_bin|claudeBin/.test(raw),
      raw.slice(0, 300),
    );
  }

  for (const name of ["plan_task", "execute_task"]) {
    const props = tools.find((t) => t.name === name)?.inputSchema?.properties ?? {};
    check(`${name} принимает model`, Object.hasOwn(props, "model"), `свойства: ${Object.keys(props).join(", ")}`);
  }

  console.log("\n2. Валидация входных параметров");

  const outside = await client.callTool({
    name: "plan_task",
    arguments: { task_text: "x", project_dir: process.platform === "win32" ? "C:\\Windows" : "/etc" },
  });
  check("каталог вне белого списка отклонён", outside.isError === true);

  const traversal = await client.callTool({
    name: "plan_task",
    arguments: { task_text: "x", project_dir: join(projectDir, "..", "..") },
  });
  check("обход через .. отклонён", traversal.isError === true);

  const missing = await client.callTool({
    name: "plan_task",
    arguments: { task_text: "x", project_dir: join(workspace, "нет-такого") },
  });
  check("несуществующий каталог отклонён", missing.isError === true);

  const relative = await client.callTool({
    name: "plan_task",
    arguments: { task_text: "x", project_dir: "./project" },
  });
  check("относительный путь отклонён", relative.isError === true);

  // Значение уходит в argv соседом к "--model": строка, начинающаяся с дефиса,
  // была бы попыткой протащить туда отдельный флаг.
  const flagAsModel = await client.callTool({
    name: "plan_task",
    arguments: {
      task_text: "x",
      project_dir: projectDir,
      model: "--dangerously-skip-permissions",
    },
  });
  check("model в виде флага отклонён схемой", flagAsModel.isError === true);

  const spacedModel = await client.callTool({
    name: "plan_task",
    arguments: { task_text: "x", project_dir: projectDir, model: "opus --sandbox" },
  });
  check("model с пробелом отклонён схемой", spacedModel.isError === true);

  console.log("\n2a. Цепочка выбора модели: вызов → конфиг → умолчание CLI");

  // Без спавна процесса: проверяем ровно то, что уходит в argv.
  const silentLogger = { write() {}, stderr() {} };
  const argsFor = (configModel, requested) =>
    new ClaudeRunner({ model: configModel, sandbox: "off" }, silentLogger).buildTaskArgs({
      permissionMode: "plan",
      taskText: "x",
      appendSystemPrompt: "x",
      model: requested,
      stream: false,
    });
  const modelArg = (args) => {
    const i = args.indexOf("--model");
    return i === -1 ? null : args[i + 1];
  };

  check(
    "вызов перекрывает конфиг",
    modelArg(argsFor("claude-opus-5", "sonnet")) === "sonnet",
    `получено: ${modelArg(argsFor("claude-opus-5", "sonnet"))}`,
  );
  check(
    "без параметра берётся модель из конфига",
    modelArg(argsFor("claude-opus-5", undefined)) === "claude-opus-5",
    `получено: ${modelArg(argsFor("claude-opus-5", undefined))}`,
  );
  check(
    "без конфига и параметра флаг не передаётся",
    modelArg(argsFor(undefined, undefined)) === null,
    `получено: ${modelArg(argsFor(undefined, undefined))}`,
  );
  check(
    "алиас haiku разворачивается в полное имя — иначе CLI планирует на Sonnet",
    modelArg(argsFor(undefined, "haiku")) === "claude-haiku-4-5" &&
      modelArg(argsFor("haiku", undefined)) === "claude-haiku-4-5",
    `получено: ${modelArg(argsFor(undefined, "haiku"))} / ${modelArg(argsFor("haiku", undefined))}`,
  );
  check(
    "другие алиасы уходят как есть",
    modelArg(argsFor(undefined, "opus")) === "opus",
    `получено: ${modelArg(argsFor(undefined, "opus"))}`,
  );

  console.log("\n2b. --settings с PreToolUse-хуками попадает в argv");

  const hookRunner = new ClaudeRunner(
    { sandbox: "off", sensitiveTools: ["Bash", "Write", "Edit"], permissionHoldSeconds: 120 },
    silentLogger,
  );
  const baseHookArgs = {
    permissionMode: "acceptEdits",
    taskText: "x",
    appendSystemPrompt: "x",
    stream: false,
  };

  const noHookArgs = hookRunner.buildTaskArgs(baseHookArgs);
  check("без hookUrl флаг --settings не передаётся", noHookArgs.indexOf("--settings") === -1);

  const hookArgs = hookRunner.buildTaskArgs({
    ...baseHookArgs,
    hookUrl: "http://127.0.0.1:12345/hook/abc",
  });
  const settingsIndex = hookArgs.indexOf("--settings");
  check("с hookUrl появился --settings", settingsIndex !== -1);

  let settings = null;
  try {
    settings = JSON.parse(hookArgs[settingsIndex + 1]);
  } catch (err) {
    check("значение --settings — валидный JSON", false, String(err));
  }
  if (settings) {
    check("значение --settings — валидный JSON", true);
    const entries = settings.hooks?.PreToolUse ?? [];
    check(
      "по записи PreToolUse на каждый чувствительный инструмент",
      entries.map((e) => e.matcher).join(",") === "Bash,Write,Edit",
      `получено: ${entries.map((e) => e.matcher).join(", ")}`,
    );
    check(
      "каждая запись указывает на URL моста",
      entries.length > 0 &&
        entries.every(
          (e) => e.hooks?.[0]?.type === "http" && e.hooks[0].url === "http://127.0.0.1:12345/hook/abc",
        ),
      JSON.stringify(entries),
    );
    // Таймаут обязан быть явным и больше удержания: истёкший таймаут CLI
    // трактует как разрешение (fail-open).
    check(
      "timeout хука = удержание + запас",
      entries.length > 0 &&
        entries.every((e) => e.hooks[0].timeout === 120 + HOOK_TIMEOUT_MARGIN_SECONDS),
      JSON.stringify(entries.map((e) => e.hooks[0].timeout)),
    );
  }

  // plan_task: auto-режим в планировании выключен всегда, хук — со своим
  // набором инструментов. Без этого opus в plan-режиме сам одобрял пишущие
  // команды (useAutoModeDuringPlan по умолчанию true).
  const settingsOf = (argv) => {
    const i = argv.indexOf("--settings");
    return i === -1 ? null : JSON.parse(argv[i + 1]);
  };
  const planNoHook = settingsOf(
    hookRunner.buildTaskArgs({ ...baseHookArgs, permissionMode: "plan" }),
  );
  check(
    "plan без хука: --settings с useAutoModeDuringPlan: false и без хуков",
    planNoHook?.useAutoModeDuringPlan === false && planNoHook.hooks === undefined,
    JSON.stringify(planNoHook),
  );
  check(
    "acceptEdits без хука: useAutoModeDuringPlan не передаётся",
    settingsOf(hookRunner.buildTaskArgs(baseHookArgs)) === null,
  );
  const planHook = settingsOf(
    hookRunner.buildTaskArgs({
      ...baseHookArgs,
      permissionMode: "plan",
      hookUrl: "http://127.0.0.1:12345/hook/abc",
      hookTools: ["Bash", "Monitor"],
    }),
  );
  check(
    "plan с хуком: матчеры из hookTools, а не из sensitiveTools, и auto-режим выключен",
    planHook?.useAutoModeDuringPlan === false &&
      (planHook.hooks?.PreToolUse ?? []).map((e) => e.matcher).join(",") === "Bash,Monitor",
    JSON.stringify(planHook),
  );

  check(
    "buildHookSettings не подставляет '*'",
    JSON.stringify(buildHookSettings("http://x/y", ["Bash"], 0)).includes('"matcher":"Bash"'),
  );
  check(
    "при нулевом удержании timeout всё равно явный",
    buildHookSettings("http://x/y", ["Bash"], 0).hooks.PreToolUse[0].hooks[0].timeout ===
      HOOK_TIMEOUT_MARGIN_SECONDS,
  );

  console.log("\n2c. HookBridge: матрица решений allow/deny/exhausted");

  const startBridge = (overrides = {}) =>
    HookBridge.start({
      sensitiveTools: ["Bash", "Write", "Edit"],
      retryBudget: 10,
      maxPendingRequests: 50,
      allowWaitCommand: true,
      autoApproveCommands: [],
      logger: silentLogger,
      ...overrides,
    });

  /** Логгер, запоминающий записи: нужен там, где проверяется сам факт записи. */
  const recordingLogger = () => {
    const records = [];
    return { records, write: (r) => records.push(r), stderr() {} };
  };

  /** POST на эндпоинт хука; возвращает распакованный hookSpecificOutput. */
  async function hookPost(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* оставляем null — проверка ниже это покажет */
    }
    return { httpStatus: res.status, ...(parsed?.hookSpecificOutput ?? {}) };
  }

  const bashCall = (command, description) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: description === undefined ? { command } : { command, description },
  });

  const bridge = await startBridge();
  try {
    check(
      "url указывает на 127.0.0.1 и содержит токен",
      /^http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f-]{36}$/.test(bridge.url),
      bridge.url,
    );
    check("порт не нулевой", Number(bridge.url.split(":")[2].split("/")[0]) > 0, bridge.url);

    const readCall = await hookPost(bridge.url, {
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x" },
    });
    check(
      "неконтролируемый инструмент пропущен",
      readCall.permissionDecision === "allow",
      JSON.stringify(readCall),
    );
    check("allow не создаёт записи", bridge.list().length === 0, JSON.stringify(bridge.list()));

    const first = await hookPost(bridge.url, bashCall("npm test", "Запустить тесты"));
    check(
      "чувствительный инструмент отклонён",
      first.permissionDecision === "deny",
      JSON.stringify(first),
    );
    check(
      "в причине сказано повторить тот же вызов",
      /повторите этот же вызов без изменений/.test(first.permissionDecisionReason ?? ""),
      first.permissionDecisionReason ?? "(пусто)",
    );
    check(
      "в причине запрещён обход",
      /другая команда с тем же эффектом уйдут оператору/.test(first.permissionDecisionReason ?? ""),
      first.permissionDecisionReason ?? "(пусто)",
    );
    check(
      "в причине есть шаг ожидания",
      /подождите/.test(first.permissionDecisionReason ?? ""),
      first.permissionDecisionReason ?? "(пусто)",
    );
    // Прежний текст дочерняя модель приняла за prompt injection. Источник назван,
    // приказов капсом и запрета честно сообщить о провале нет.
    check(
      "причина начинается с названия источника",
      (first.permissionDecisionReason ?? "").startsWith("Мост разрешений ccc-mcp:"),
      first.permissionDecisionReason ?? "(пусто)",
    );
    check(
      "в причине нет слов капсом",
      !/[А-ЯЁA-Z]{4,}/.test((first.permissionDecisionReason ?? "").replace(/ccc-mcp/g, "")),
      first.permissionDecisionReason ?? "(пусто)",
    );
    check(
      "причина не запрещает сообщать о провале",
      !/не сообщай/i.test(first.permissionDecisionReason ?? ""),
      first.permissionDecisionReason ?? "(пусто)",
    );
    check("создана одна запись", bridge.list().length === 1, JSON.stringify(bridge.list()));

    const requestId = bridge.list()[0].requestId;
    check("request_id — 12 hex", /^[0-9a-f]{12}$/.test(requestId), requestId);
    check("запись в состоянии pending", bridge.list()[0].decision === "pending");
    check("pendingCount учитывает запись", bridge.pendingCount() === 1);
    check(
      "summary показывает команду",
      bridge.list()[0].summary === "npm test",
      bridge.list()[0].summary,
    );

    await hookPost(bridge.url, bashCall("npm test", "Запустить тесты"));
    check(
      "повтор не плодит записей",
      bridge.list().length === 1,
      JSON.stringify(bridge.list().map((r) => r.requestId)),
    );
    check(
      "denied_count = 2 после второй попытки",
      bridge.list()[0].deniedCount === 2,
      String(bridge.list()[0].deniedCount),
    );

    // description модель почти наверняка перефразирует — на ключ он влиять не должен.
    await hookPost(bridge.url, bashCall("npm test", "Прогнать тесты ещё раз"));
    check(
      "другой description даёт тот же request_id",
      bridge.list().length === 1 && bridge.list()[0].requestId === requestId,
      JSON.stringify(bridge.list().map((r) => r.requestId)),
    );

    // Порядок ключей в JSON произволен — канонизация обязана его нивелировать.
    await hookPost(bridge.url, {
      tool_name: "Write",
      tool_input: { content: "hi", file_path: "/tmp/a.txt" },
    });
    const writeId = bridge.list().find((r) => r.toolName === "Write")?.requestId;
    await hookPost(bridge.url, {
      tool_name: "Write",
      tool_input: { file_path: "/tmp/a.txt", content: "hi" },
    });
    check(
      "перестановка ключей даёт тот же request_id",
      bridge.list().filter((r) => r.toolName === "Write").length === 1,
      JSON.stringify(bridge.list().map((r) => `${r.toolName}:${r.requestId}`)),
    );
    check(
      "summary для Write показывает путь и объём",
      bridge.list().find((r) => r.requestId === writeId)?.summary === "/tmp/a.txt (2 симв.)",
      bridge.list().find((r) => r.requestId === writeId)?.summary,
    );

    bridge.resolve(requestId, "allow");
    const afterAllow = await hookPost(bridge.url, bashCall("npm test", "Запустить тесты"));
    check(
      "после одобрения вызов проходит",
      afterAllow.permissionDecision === "allow",
      JSON.stringify(afterAllow),
    );
    check("allowed_count = 1", bridge.list()[0].allowedCount === 1, String(bridge.list()[0].allowedCount));
    check("одобренная запись не считается pending", bridge.pendingCount() === 1);

    // Отзыв: одобрение «липкое», но не безотзывное.
    bridge.resolve(requestId, "deny", "передумал");
    const afterRevoke = await hookPost(bridge.url, bashCall("npm test", "Запустить тесты"));
    check(
      "отзыв одобрения снова блокирует вызов",
      afterRevoke.permissionDecision === "deny",
      JSON.stringify(afterRevoke),
    );
    check(
      "в причине отказа виден комментарий оператора",
      /передумал/.test(afterRevoke.permissionDecisionReason ?? ""),
      afterRevoke.permissionDecisionReason ?? "(пусто)",
    );

    let unknownRejected = false;
    try {
      bridge.resolve("000000000000", "allow");
    } catch {
      unknownRejected = true;
    }
    check("resolve с неизвестным request_id отклонён", unknownRejected === true);

    console.log("\n2d. HookBridge: паузы, битый ввод и защита от перебора");

    const beforeSleep = bridge.list().length;
    const sleepOk = await hookPost(bridge.url, bashCall("sleep 30"));
    check("sleep 30 разрешён без одобрения", sleepOk.permissionDecision === "allow", JSON.stringify(sleepOk));
    check("пауза не создаёт записи", bridge.list().length === beforeSleep);

    // Фоновая пауза возвращается мгновенно и ждать модель не заставляет, поэтому
    // исключение на неё не распространяется. bashCall кладёт в tool_input только
    // command/description — здесь нужен сырой объект.
    const beforeBackgroundSleep = bridge.list().length;
    const sleepBackground = await hookPost(bridge.url, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "sleep 30", run_in_background: true },
    });
    check(
      "фоновая sleep 30 требует одобрения",
      sleepBackground.permissionDecision === "deny",
      JSON.stringify(sleepBackground),
    );
    // Мало того, что отклонён: важно, что вызов попал оператору на рассмотрение,
    // а не утонул в overflow.
    check(
      "фоновая пауза заводит pending-запрос",
      bridge.list().length === beforeBackgroundSleep + 1 &&
        bridge.list().at(-1)?.decision === "pending",
      JSON.stringify(bridge.list().map((r) => [r.summary, r.decision])),
    );

    const sleepTooLong = await hookPost(bridge.url, bashCall("sleep 300"));
    check("sleep 300 отклонён", sleepTooLong.permissionDecision === "deny", JSON.stringify(sleepTooLong));
    const sleepChained = await hookPost(bridge.url, bashCall("sleep 30; rm -rf /"));
    check(
      "sleep с довеском отклонён",
      sleepChained.permissionDecision === "deny",
      JSON.stringify(sleepChained),
    );

    const broken = await hookPost(bridge.url, "{не json");
    check("битый JSON даёт deny, а не 500", broken.httpStatus === 200 && broken.permissionDecision === "deny", JSON.stringify(broken));

    const huge = await hookPost(bridge.url, {
      tool_name: "Write",
      tool_input: { file_path: "/tmp/big", content: "x".repeat(1024 * 1024 + 64) },
    });
    check(
      "тело больше 1 МБ даёт deny, а не 500",
      huge.httpStatus === 200 && huge.permissionDecision === "deny",
      JSON.stringify(huge),
    );

    const badToken = await fetch(`${bridge.url}-неверный`, { method: "POST", body: "{}" });
    check("неверный токен даёт 404", badToken.status === 404, String(badToken.status));
    await badToken.text();

    const getRequest = await fetch(bridge.url, { method: "GET" });
    check("GET на эндпоинт даёт 404", getRequest.status === 404, String(getRequest.status));
    await getRequest.text();
  } finally {
    bridge.stopListening();
  }

  check("после stopListening записи сохранены", bridge.list().length >= 2, String(bridge.list().length));
  let portClosed = false;
  try {
    await hookPost(bridge.url, bashCall("npm test"));
  } catch {
    portClosed = true;
  }
  check("после stopListening порт закрыт", portClosed === true);

  const budgetBridge = await startBridge({ retryBudget: 2 });
  try {
    const attempt1 = await hookPost(budgetBridge.url, bashCall("rm -rf /tmp/x"));
    const attempt2 = await hookPost(budgetBridge.url, bashCall("rm -rf /tmp/x"));
    const attempt3 = await hookPost(budgetBridge.url, bashCall("rm -rf /tmp/x"));
    check(
      "в пределах бюджета отказ зовёт повторить",
      /повторите этот же вызов без изменений/.test(attempt1.permissionDecisionReason ?? "") &&
        /повторите этот же вызов без изменений/.test(attempt2.permissionDecisionReason ?? ""),
      attempt2.permissionDecisionReason ?? "(пусто)",
    );
    check(
      "третья попытка исчерпывает бюджет",
      budgetBridge.list()[0].decision === "exhausted",
      budgetBridge.list()[0].decision,
    );
    check(
      "исчерпание — это deny, а не allow",
      attempt3.permissionDecision === "deny",
      JSON.stringify(attempt3),
    );
    check(
      "в терминальной причине велено прекратить попытки",
      /Повторять этот вызов больше не нужно/.test(attempt3.permissionDecisionReason ?? ""),
      attempt3.permissionDecisionReason ?? "(пусто)",
    );

    // Оператор всё ещё может разблокировать исчерпанный запрос.
    budgetBridge.resolve(budgetBridge.list()[0].requestId, "allow");
    const afterRescue = await hookPost(budgetBridge.url, bashCall("rm -rf /tmp/x"));
    check(
      "одобрение важнее исчерпанного бюджета",
      afterRescue.permissionDecision === "allow",
      JSON.stringify(afterRescue),
    );
  } finally {
    budgetBridge.stopListening();
  }

  const limitBridge = await startBridge({ maxPendingRequests: 1 });
  try {
    await hookPost(limitBridge.url, bashCall("echo один"));
    const overflow = await hookPost(limitBridge.url, bashCall("echo два"));
    check(
      "сверх лимита запрос отклонён",
      overflow.permissionDecision === "deny",
      JSON.stringify(overflow),
    );
    check(
      "сверх лимита запись не создаётся",
      limitBridge.list().length === 1,
      JSON.stringify(limitBridge.list().map((r) => r.summary)),
    );
  } finally {
    limitBridge.stopListening();
  }

  const noWaitBridge = await startBridge({ allowWaitCommand: false });
  try {
    const sleepDenied = await hookPost(noWaitBridge.url, bashCall("sleep 30"));
    check(
      "при allowWaitCommand:false пауза тоже требует одобрения",
      sleepDenied.permissionDecision === "deny",
      JSON.stringify(sleepDenied),
    );
    // Советовать sleep в этой ветке значило бы звать модель на вызов, который
    // мост сам же отклонит, сжигая попытку.
    check(
      "при allowWaitCommand:false подсказка не предлагает sleep",
      !/sleep/i.test(sleepDenied.permissionDecisionReason ?? ""),
      sleepDenied.permissionDecisionReason ?? "(пусто)",
    );
  } finally {
    noWaitBridge.stopListening();
  }

  console.log("\n2e. HookBridge: автоодобрение точных команд");

  const AUTO_LIST = ["npm run typecheck", "npm run build", "npm run smoke -- --no-live"];
  const autoLog = recordingLogger();
  const autoBridge = await startBridge({
    autoApproveCommands: AUTO_LIST,
    logger: autoLog,
  });
  try {
    // 1. Точное совпадение: allow и никакой записи в реестре.
    const before = autoBridge.list().length;
    const exact = await hookPost(autoBridge.url, bashCall("npm run typecheck"));
    check(
      "точная команда из списка разрешена без одобрения",
      exact.permissionDecision === "allow",
      JSON.stringify(exact),
    );
    check(
      "автоодобрение не создаёт pending-записи",
      autoBridge.list().length === before,
      JSON.stringify(autoBridge.list().map((r) => [r.summary, r.decision])),
    );

    // 2. Единственная нормализация — trim по краям.
    const padded = await hookPost(autoBridge.url, bashCall("  npm run typecheck  "));
    check(
      "пробелы по краям не мешают совпадению",
      padded.permissionDecision === "allow",
      JSON.stringify(padded),
    );

    // 3. Внутренние пробелы НЕ схлопываются: иначе `echo "a  b"` прошло бы по
    // одобрению `echo "a b"`.
    const beforeInner = autoBridge.list().length;
    const innerSpace = await hookPost(autoBridge.url, bashCall("npm  run typecheck"));
    check(
      "лишний пробел внутри команды ломает совпадение",
      innerSpace.permissionDecision === "deny",
      JSON.stringify(innerSpace),
    );
    check(
      "несовпавшая команда идёт обычным путём и заводит запрос",
      autoBridge.list().length === beforeInner + 1 &&
        autoBridge.list().at(-1)?.decision === "pending",
      JSON.stringify(autoBridge.list().map((r) => [r.summary, r.decision])),
    );

    // 4-6. Совпадение считается по всей строке: ни хвост, ни довесок, ни префикс.
    const extraArg = await hookPost(autoBridge.url, bashCall("npm run typecheck --watch"));
    check(
      "другой аргумент не автоодобряется",
      extraArg.permissionDecision === "deny",
      JSON.stringify(extraArg),
    );
    const chained = await hookPost(autoBridge.url, bashCall("npm run typecheck && rm -rf /"));
    check(
      "команда с довеском не автоодобряется",
      chained.permissionDecision === "deny",
      JSON.stringify(chained),
    );
    const prefixOnly = await hookPost(autoBridge.url, bashCall("npm run"));
    check(
      "префикс строки из списка не автоодобряется",
      prefixOnly.permissionDecision === "deny",
      JSON.stringify(prefixOnly),
    );

    // 7. Записи списка работают независимо, а близкая к ним, но отсутствующая
    // `npm run smoke` (без --no-live, то есть с тратой токенов) — нет.
    const second = await hookPost(autoBridge.url, bashCall("npm run build"));
    const third = await hookPost(autoBridge.url, bashCall("npm run smoke -- --no-live"));
    check(
      "каждая строка списка действует сама по себе",
      second.permissionDecision === "allow" && third.permissionDecision === "allow",
      `${JSON.stringify(second)} / ${JSON.stringify(third)}`,
    );
    const liveSmoke = await hookPost(autoBridge.url, bashCall("npm run smoke"));
    check(
      "небесплатный вариант той же команды не просачивается",
      liveSmoke.permissionDecision === "deny",
      JSON.stringify(liveSmoke),
    );

    // 10. Фон не отменяет автоодобрение, в отличие от паузы: `sleep` в фоне
    // теряет весь свой смысл, а сборка — нет.
    const beforeBackground = autoBridge.list().length;
    const background = await hookPost(autoBridge.url, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm run build", run_in_background: true },
    });
    check(
      "фоновый вызов автоодобряется наравне с обычным",
      background.permissionDecision === "allow",
      JSON.stringify(background),
    );
    check(
      "фоновое автоодобрение тоже не создаёт записи",
      autoBridge.list().length === beforeBackground,
      String(autoBridge.list().length),
    );

    // 11. Незнакомое поле может менять то, КАК команда выполнится, поэтому
    // fail-closed: вызов уходит оператору.
    const beforeUnknown = autoBridge.list().length;
    const unknownField = await hookPost(autoBridge.url, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm run build", какое_то_новое_поле: "x" },
    });
    check(
      "незнакомое поле tool_input отменяет автоодобрение",
      unknownField.permissionDecision === "deny",
      JSON.stringify(unknownField),
    );
    check(
      "вызов с незнакомым полем уходит оператору",
      autoBridge.list().length === beforeUnknown + 1,
      String(autoBridge.list().length),
    );

    // 12. Механизм специфичен для Bash: у Write единственной строки-команды нет.
    const writeCall = await hookPost(autoBridge.url, {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { command: "npm run build", file_path: "/tmp/x", content: "y" },
    });
    check(
      "поле command у не-Bash инструмента ничего не разрешает",
      writeCall.permissionDecision === "deny",
      JSON.stringify(writeCall),
    );

    // 13. Непрозрачный тип command — deny, а не падение обработчика.
    const numericCommand = await hookPost(autoBridge.url, {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: 42 },
    });
    check(
      "нестроковый command даёт deny без падения",
      numericCommand.httpStatus === 200 && numericCommand.permissionDecision === "deny",
      JSON.stringify(numericCommand),
    );

    // 14. Нерегрессия: пауза работает и при непустом списке автоодобрения.
    const sleepStillOk = await hookPost(autoBridge.url, bashCall("sleep 30"));
    check(
      "пауза работает и при непустом autoApproveCommands",
      sleepStillOk.permissionDecision === "allow",
      JSON.stringify(sleepStillOk),
    );

    // 9. Лог: автоодобрение отличимо от allow оператора.
    const autoRecords = autoLog.records.filter((r) => r.decision === "auto_allowed");
    check(
      "автоодобрение попадает в лог как auto_allowed",
      autoRecords.length > 0 &&
        autoRecords.every(
          (r) => r.event === "hook" && r.outcome === "allow" && r.tool_name === "Bash",
        ),
      JSON.stringify(autoRecords.slice(0, 2)),
    );
    check(
      "в записи автоодобрения есть выжимка и request_id",
      autoRecords[0]?.summary === "npm run typecheck" &&
        /^[0-9a-f]{12}$/.test(autoRecords[0]?.request_id ?? ""),
      JSON.stringify(autoRecords[0]),
    );
    // Счётчиков попыток у автоодобрения нет: эпизода «отказ → ожидание →
    // одобрение» не было, считать нечего.
    check(
      "в записи автоодобрения нет счётчиков попыток",
      autoRecords.every((r) => r.denied_count === undefined && r.allowed_count === undefined),
      JSON.stringify(autoRecords[0]),
    );

    const operatorRequestId = autoBridge.list().find((r) => r.decision === "pending")?.requestId;
    autoBridge.resolve(operatorRequestId, "allow");
    await hookPost(autoBridge.url, bashCall("npm  run typecheck"));
    const operatorRecord = autoLog.records.filter((r) => r.decision === "approved").at(-1);
    check(
      "allow оператора отличим от автоодобрения по decision",
      operatorRecord?.outcome === "allow" &&
        operatorRecord?.decision === "approved" &&
        operatorRecord?.allowed_count === 1,
      JSON.stringify(operatorRecord),
    );
  } finally {
    autoBridge.stopListening();
  }

  // 8. Дефолт (пустой список) ничего не меняет.
  const noAutoBridge = await startBridge();
  try {
    const denied = await hookPost(noAutoBridge.url, bashCall("npm run typecheck"));
    check(
      "с пустым autoApproveCommands поведение прежнее",
      denied.permissionDecision === "deny" && noAutoBridge.list().length === 1,
      JSON.stringify(denied),
    );
  } finally {
    noAutoBridge.stopListening();
  }

  console.log("\n2e-ro. Классификатор читающих команд для plan_task");
  {
    // Реальные команды разведки из plan_task 24.09 и близкие к ним.
    const readOnly = [
      "ls -la tools/verify-a3-b5/",
      "grep -rn 'CallReconciler' --include=*.cs backend/ | grep -v '/obj/' | head -30",
      `grep -n "MapDelete\\|Evict" backend/src/Endpoints.cs | head -40`,
      "find backend -name '*.csproj' -not -path '*/obj/*' | sort",
      "find backend -name '*.csproj' | xargs grep -l -i livekit 2>/dev/null",
      "sed -n '1,60p' infra/docker-compose.yml",
      "sed -n '/^volumes:/,$p' infra/docker-compose.yml",
      "cat backend/Dockerfile && wc -l tools/run.py",
      "cd backend && grep -rn --include=\"*.cs\" \"xmin\" src/ ; echo \"EXIT: $?\"",
      "X=~/.nuget/packages/lk/1.2.3/LivekitApi.xml; grep -n 'UpdateParticipant' \"$X\" | head",
      "docker ps --format '{{.Names}}\\t{{.Status}}'",
      "docker logs --since 20m app-livekit 2>&1 | grep -v $'\\t' | head -5",
      "docker inspect app-api --format '{{.Config.Image}}'",
      "docker compose -f docker-compose.yml -f docker-compose.dev.yml ps",
      "git log --oneline -3 && git status --short",
      "git show --stat 72cdb46 | head -40",
      "git -C backend diff HEAD~1 -- src/",
      "awk 'NR==160' docs/plan.md | cut -c1-1200",
      "strings -a lib/LivekitApi.dll 2>/dev/null | grep -iE 'twirp' | sort -u | head",
      "head -45 tests/CoturnCredentialServiceTests.cs",
      "date -u +%H:%M:%SZ; pgrep -fl chromium",
      "dotnet --list-sdks",
      // Шаблоны .env без значений — не секреты.
      "grep -n 'OBJECTSTORE' infra/docker-compose.yml infra/.env.example",
      "cat .env.sample",
    ];
    const needsOperator = [
      // Интерпретаторы, запуск по пути, сеть, docker exec.
      "python3 -c \"open('x','w').write('y')\"",
      "./w.sh m1",
      "tools/verify/.venv/bin/python run.py reset",
      "curl -s http://localhost:8080/",
      "docker exec app-postgres psql -c 'SELECT 1'",
      "docker compose up -d --build",
      "docker compose -f a.yml down",
      "npm run build",
      // Запись.
      "strings lib/x.dll > /tmp/out.txt",
      "grep -n x f >> log.txt",
      "echo hi | tee out.txt",
      "sed -i 's/a/b/' file.txt",
      "sed 's/a/b/w out.txt' file.txt",
      "find . -name '*.tmp' -delete",
      "find . -exec rm {} \\;",
      "sort -o out.txt in.txt",
      "uniq in.txt out.txt",
      "awk '{print > \"out.txt\"}' in.txt",
      "awk 'BEGIN{system(\"rm -rf x\")}'",
      "git checkout main",
      "git branch new-feature",
      "git -c core.pager='rm -rf x' log",
      "git diff --output=patch.txt",
      "rg --pre ./evil.sh pattern",
      "xargs rm < list.txt",
      "ls | xargs -I{} sh -c 'rm {}'",
      // Подстановки, фон, циклы, heredoc, присваивание перед командой.
      "cat $(which foo)",
      "cat `which foo`",
      "echo \"$(rm -rf x)\"",
      "diff <(ls a) <(ls b)",
      "sleep 100 &",
      "for f in *.cs; do cat $f; done",
      "cat <<EOF\nx\nEOF",
      "(cd x && ls)",
      "GIT_EXTERNAL_DIFF=./x.sh git diff",
      "LD_PRELOAD=./x.so cat f",
      // Секреты оператор видит всегда.
      "grep -n 'API_SECRET' infra/.env",
      "cat ~/.ssh/id_rsa",
      "cat certs/server.key",
      "cat ~/.aws/credentials",
      "ls secrets/",
      "cat .env.production",
      "cat .env.example.local",
      "cat secrets/.env.example",
    ];
    for (const c of readOnly) {
      check(`читающая: ${c.replace(/\n/g, "⏎").slice(0, 70)}`, isReadOnlyCommand(c) === true);
    }
    for (const c of needsOperator) {
      check(`к оператору: ${c.replace(/\n/g, "⏎").slice(0, 70)}`, isReadOnlyCommand(c) === false);
    }

    // Мост: флаг включает автоодобрение, по умолчанию его нет.
    const roLog = recordingLogger();
    const roBridge = await startBridge({
      sensitiveTools: ["Bash", "Monitor"],
      autoApproveReadOnly: true,
      logger: roLog,
    });
    try {
      const grepCall = await hookPost(roBridge.url, bashCall("grep -rn Reconcil backend | head"));
      check(
        "читающая команда при autoApproveReadOnly проходит без записи в реестре",
        grepCall.permissionDecision === "allow" && roBridge.list().length === 0,
        JSON.stringify(grepCall),
      );
      check(
        "в логе auto_allowed с rule: read_only",
        roLog.records.some((r) => r.decision === "auto_allowed" && r.rule === "read_only"),
        JSON.stringify(roLog.records.at(-1)),
      );
      const writeCall = await hookPost(roBridge.url, bashCall("python3 -c \"open('x','w')\""));
      check(
        "нечитающая команда при autoApproveReadOnly всё равно идёт оператору",
        writeCall.permissionDecision === "deny" && roBridge.list().length === 1,
        JSON.stringify(writeCall),
      );
      const monitorCall = await hookPost(roBridge.url, {
        hook_event_name: "PreToolUse",
        tool_name: "Monitor",
        tool_input: { command: "ls" },
      });
      check(
        "классификатор не распространяется на Monitor",
        monitorCall.permissionDecision === "deny",
        JSON.stringify(monitorCall),
      );
    } finally {
      roBridge.stopListening();
    }
    const strictBridge = await startBridge();
    try {
      const grepStrict = await hookPost(strictBridge.url, bashCall("grep -rn Reconcil backend | head"));
      check(
        "без autoApproveReadOnly читающая команда идёт оператору",
        grepStrict.permissionDecision === "deny" && strictBridge.list().length === 1,
        JSON.stringify(grepStrict),
      );
    } finally {
      strictBridge.stopListening();
    }
  }

  console.log("\n2e-absent. HookBridge: оператор не выходит на связь");
  {
    let absentMs = null; // null — оператор на связи
    const absLog = recordingLogger();
    const absBridge = await startBridge({ operatorAbsentMs: () => absentMs, logger: absLog });
    try {
      // Пока оператор на связи — обычный путь: запрос ждёт решения.
      const early = await hookPost(absBridge.url, bashCall("npm run build"));
      check(
        "при операторе на связи запрос ждёт решения, как раньше",
        early.permissionDecision === "deny" &&
          absBridge.list()[0]?.decision === "pending" &&
          absBridge.list()[0]?.operatorAbsent === false,
        JSON.stringify(early),
      );
      // Одобрим другой запрос заранее — он должен проходить и без оператора.
      await hookPost(absBridge.url, bashCall("npm test"));
      const testReq = absBridge.list().find((r) => r.summary === "npm test");
      absBridge.resolve(testReq.requestId, "allow");

      absentMs = 12 * 60_000;
      const retry = await hookPost(absBridge.url, bashCall("npm run build"));
      const buildReq = absBridge.list().find((r) => r.summary === "npm run build");
      check(
        "ждущий запрос при молчащем операторе закрывается окончательным отказом",
        retry.permissionDecision === "deny" &&
          /не выходит на связь уже 12 мин/.test(retry.permissionDecisionReason) &&
          /перечислите в итоговом отчёте/.test(retry.permissionDecisionReason) &&
          buildReq.decision === "denied" &&
          buildReq.operatorAbsent === true,
        JSON.stringify({ retry, buildReq }),
      );
      const fresh = await hookPost(absBridge.url, bashCall("docker compose up -d"));
      const freshReq = absBridge.list().find((r) => r.summary === "docker compose up -d");
      check(
        "новый запрос при молчащем операторе отклоняется сразу, но попадает в реестр",
        fresh.permissionDecision === "deny" &&
          /не выходит на связь/.test(fresh.permissionDecisionReason) &&
          freshReq?.decision === "denied" &&
          freshReq.operatorAbsent === true,
        JSON.stringify({ fresh, freshReq }),
      );
      const approvedStill = await hookPost(absBridge.url, bashCall("npm test"));
      check(
        "одобренный ранее запрос проходит и без оператора",
        approvedStill.permissionDecision === "allow",
        JSON.stringify(approvedStill),
      );
      const again = await hookPost(absBridge.url, bashCall("docker compose up -d"));
      check(
        "повтор отклонённого за отсутствием остаётся отказом",
        again.permissionDecision === "deny",
        JSON.stringify(again),
      );
      check(
        "в логе отказ за отсутствием помечен operator_absent",
        absLog.records.some((r) => r.event === "hook" && r.decision === "denied" && r.operator_absent === true),
        JSON.stringify(absLog.records.at(-1)),
      );
    } finally {
      absBridge.stopListening();
    }

    // Механизм выключен (или оператор на связи) — поведение прежнее.
    const offBridge = await startBridge({ operatorAbsentMs: () => null });
    try {
      const r = await hookPost(offBridge.url, bashCall("npm run build"));
      check(
        "без отсутствия оператора запрос остаётся pending",
        r.permissionDecision === "deny" && offBridge.list()[0]?.decision === "pending",
        JSON.stringify(r),
      );
    } finally {
      offBridge.stopListening();
    }
  }

  console.log("\n2e+. HookBridge: удержание вызова до решения оператора");
  {
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    /** Ждёт появления запроса в реестре: POST асинхронный. */
    const firstRequest = async (b) => {
      for (let i = 0; i < 100 && b.list().length === 0; i++) await sleepMs(10);
      return b.list()[0];
    };

    // 1. Одобрение во время удержания — allow с первой же попытки.
    const holdLogger = recordingLogger();
    const holdBridge = await startBridge({ holdMs: 5_000, logger: holdLogger });
    try {
      const pending = hookPost(holdBridge.url, bashCall("dotnet --version"));
      const req = await firstRequest(holdBridge);
      check("удержанный запрос виден как pending", req?.decision === "pending", JSON.stringify(req));
      check("удержание будит ожидающих так же, как отказ", holdBridge.pendingRevision === 1);
      const t0 = Date.now();
      holdBridge.resolve(req.requestId, "allow");
      const res = await pending;
      check(
        "одобрение отвечает удержанному вызову сразу allow",
        res.permissionDecision === "allow" && Date.now() - t0 < 2_000,
        JSON.stringify(res),
      );
      const after = holdBridge.list()[0];
      check(
        "удержание отказом не считается: отказов 0, пропуск один",
        after.deniedCount === 0 && after.allowedCount === 1,
        JSON.stringify(after),
      );
      const hookLogs = holdLogger.records.filter((r) => r.event === "hook");
      check(
        "в лог — одна запись по итогу, а не отказ на входе",
        hookLogs.length === 1 && hookLogs[0].outcome === "allow",
        JSON.stringify(hookLogs),
      );
    } finally {
      holdBridge.stopListening();
    }

    // 2. Отказ оператора во время удержания.
    const denyBridge = await startBridge({ holdMs: 5_000 });
    try {
      const pending = hookPost(denyBridge.url, bashCall("docker compose ps"));
      const req = await firstRequest(denyBridge);
      denyBridge.resolve(req.requestId, "deny", "не сейчас");
      const res = await pending;
      check(
        "отказ оператора отвечает удержанному вызову deny с причиной",
        res.permissionDecision === "deny" &&
          /оператор отклонил запрос/.test(res.permissionDecisionReason) &&
          /не сейчас/.test(res.permissionDecisionReason),
        JSON.stringify(res),
      );
      check("отказ оператора засчитан один раз", denyBridge.list()[0].deniedCount === 1);
    } finally {
      denyBridge.stopListening();
    }

    // 3. Истёкшее удержание — прежний отказ с просьбой повторить; повтор держится снова.
    const timeoutBridge = await startBridge({ holdMs: 200 });
    try {
      const first = await hookPost(timeoutBridge.url, bashCall("git diff"));
      check(
        "по истечении удержания — отказ «попытка 1»",
        first.permissionDecision === "deny" && /попытка 1 из 10/.test(first.permissionDecisionReason),
        JSON.stringify(first),
      );
      check(
        "отказ после удержания говорит, сколько ждали",
        /за [1-9]\d* с его не было/.test(first.permissionDecisionReason),
        first.permissionDecisionReason,
      );
      const second = hookPost(timeoutBridge.url, bashCall("git diff"));
      await sleepMs(50);
      const req = timeoutBridge.list()[0];
      check(
        "повтор снова удержан, в отказах только истёкшая попытка",
        req.deniedCount === 1 && req.decision === "pending",
        JSON.stringify(req),
      );
      timeoutBridge.resolve(req.requestId, "allow");
      const res = await second;
      check("повтор одобрен во время удержания", res.permissionDecision === "allow", JSON.stringify(res));
    } finally {
      timeoutBridge.stopListening();
    }

    // 3b. Бюджет при удержании: считаются только истёкшие попытки, порог прежний.
    const budgetBridge = await startBridge({ holdMs: 50, retryBudget: 2 });
    try {
      const r1 = await hookPost(budgetBridge.url, bashCall("make"));
      const r2 = await hookPost(budgetBridge.url, bashCall("make"));
      const r3 = await hookPost(budgetBridge.url, bashCall("make"));
      const rec = budgetBridge.list()[0];
      check(
        "при удержании бюджет кончается на той же попытке, что и без него",
        /попытка 1 из 2/.test(r1.permissionDecisionReason) &&
          /попытка 2 из 2/.test(r2.permissionDecisionReason) &&
          r3.permissionDecision === "deny" &&
          rec.decision === "exhausted" &&
          rec.deniedCount === 3,
        JSON.stringify({ r1, r2, r3, rec }),
      );
    } finally {
      budgetBridge.stopListening();
    }

    // 4. Обрыв соединения — не решение: запрос остаётся pending, одобрение не падает.
    const abortBridge = await startBridge({ holdMs: 5_000 });
    try {
      const ac = new AbortController();
      const aborted = fetch(abortBridge.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bashCall("ls -la")),
        signal: ac.signal,
      }).catch(() => "aborted");
      const req = await firstRequest(abortBridge);
      ac.abort();
      check("обрыв клиента завершает запрос без ответа", (await aborted) === "aborted");
      await sleepMs(50);
      check("после обрыва запрос всё ещё pending", abortBridge.list()[0].decision === "pending");
      let threw = false;
      try {
        abortBridge.resolve(req.requestId, "allow");
      } catch {
        threw = true;
      }
      check("одобрение после обрыва не падает", threw === false);
      const retry = await hookPost(abortBridge.url, bashCall("ls -la"));
      check("повтор после обрыва проходит по одобрению", retry.permissionDecision === "allow");
    } finally {
      abortBridge.stopListening();
    }

    // 5. Остановка моста во время удержания не роняет процесс.
    const stopBridge = await startBridge({ holdMs: 5_000 });
    const held = hookPost(stopBridge.url, bashCall("sleep-free")).then(
      () => "answered",
      () => "closed",
    );
    await firstRequest(stopBridge);
    stopBridge.stopListening();
    check("stopListening закрывает удержанное соединение", (await held) === "closed");
  }

  console.log("\n2f. approve_permission_request без включённых хуков");

  const approveUnknownJob = await client.callTool({
    name: "approve_permission_request",
    arguments: {
      process_id: "00000000-0000-0000-0000-000000000000",
      request_id: "000000000000",
      decision: "allow",
    },
  });
  check("неизвестный process_id отклонён", approveUnknownJob.isError === true);

  console.log("\n2g. Файловые инструменты: чтение и запись напрямую");

  const readFileTool = (args) => client.callTool({ name: "read_project_file", arguments: args });
  const writeFileTool = (args) => client.callTool({ name: "write_project_file", arguments: args });
  // Ошибки приходят обычным текстом, а не JSON, — report() к ним не применим.
  const errText = (result) => result.content?.[0]?.text ?? "";

  const readmeText = "# smoke test project\n";
  const readOk = await readFileTool({ project_dir: projectDir, path: "README.md" });
  check("чтение файла проекта прошло", readOk.isError !== true, errText(readOk));
  const readOkBody = readOk.isError === true ? {} : report(readOk);
  check(
    "содержимое вернулось как есть",
    readOkBody.content === readmeText,
    JSON.stringify(readOkBody.content),
  );
  check(
    "метаданные на месте",
    readOkBody.bytes === Buffer.byteLength(readmeText, "utf8") &&
      readOkBody.encoding === "utf-8" &&
      readOkBody.eol === "lf" &&
      readOkBody.lines === 1 &&
      readOkBody.has_bom === false &&
      Number.isFinite(Date.parse(readOkBody.mtime ?? "")),
    JSON.stringify(readOkBody),
  );

  writeFileSync(join(projectDir, "empty.txt"), "");
  const readEmpty = await readFileTool({ project_dir: projectDir, path: "empty.txt" });
  check(
    "пустой файл читается штатно, а не как отсутствующий",
    readEmpty.isError !== true && report(readEmpty).content === "" && report(readEmpty).bytes === 0,
    errText(readEmpty),
  );

  const readMissing = await readFileTool({ project_dir: projectDir, path: "нет-такого.md" });
  check(
    "несуществующий файл даёт понятную ошибку",
    readMissing.isError === true && /не найден/.test(errText(readMissing)),
    errText(readMissing),
  );

  const readTraversal = await readFileTool({ project_dir: projectDir, path: "../../etc/passwd" });
  check("чтение через ../ отклонено", readTraversal.isError === true, errText(readTraversal));

  const readTraversalInner = await readFileTool({
    project_dir: projectDir,
    path: "docs/../../secret",
  });
  check(
    "обход внутри строки пути отклонён",
    readTraversalInner.isError === true,
    errText(readTraversalInner),
  );

  const readAbsOutside = await readFileTool({
    project_dir: projectDir,
    path: process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hosts",
  });
  check("абсолютный path вне проекта отклонён", readAbsOutside.isError === true, errText(readAbsOutside));

  // Даже указывающий внутрь: интерфейс принимает только относительные пути.
  const readAbsInside = await readFileTool({
    project_dir: projectDir,
    path: join(projectDir, "README.md"),
  });
  check("абсолютный path внутрь проекта тоже отклонён", readAbsInside.isError === true, errText(readAbsInside));

  const readOutsideRoot = await readFileTool({
    project_dir: process.platform === "win32" ? "C:\\Windows" : "/etc",
    path: "hosts",
  });
  check("project_dir вне белого списка отклонён", readOutsideRoot.isError === true, errText(readOutsideRoot));

  let symlinkMade = false;
  try {
    symlinkSync(
      process.platform === "win32" ? "C:\\Windows\\win.ini" : "/etc/hosts",
      join(projectDir, "link.md"),
    );
    symlinkMade = true;
  } catch {
    // На Windows симлинк требует прав — проверку молча пропускаем.
  }
  if (symlinkMade) {
    const readSymlink = await readFileTool({ project_dir: projectDir, path: "link.md" });
    check(
      "симлинка за пределы проекта отклонена",
      readSymlink.isError === true,
      errText(readSymlink),
    );
  }

  const readDir = await readFileTool({ project_dir: projectDir, path: "." });
  check(
    "каталог вместо файла отклонён",
    readDir.isError === true && /не является обычным файлом/.test(errText(readDir)),
    errText(readDir),
  );

  // 600 KiB — заведомо больше дефолтного maxFileBytes (512 KiB).
  const bigText = "a".repeat(600 * 1024);
  writeFileSync(join(projectDir, "big.txt"), bigText);
  const readBig = await readFileTool({ project_dir: projectDir, path: "big.txt" });
  check(
    "слишком большой файл отклонён без частичного чтения",
    readBig.isError === true &&
      /слишком больш/.test(errText(readBig)) &&
      !errText(readBig).includes("aaaa"),
    errText(readBig),
  );

  writeFileSync(
    join(projectDir, "bin.dat"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  );
  const readBinary = await readFileTool({ project_dir: projectDir, path: "bin.dat" });
  check(
    "бинарный файл отклонён",
    readBinary.isError === true && /бинарн/.test(errText(readBinary)),
    errText(readBinary),
  );

  const writeNew = await writeFileTool({
    project_dir: projectDir,
    path: "notes/new.md",
    content: "# заметки\n",
  });
  check("запись нового файла прошла", writeNew.isError !== true, errText(writeNew));
  const writeNewBody = writeNew.isError === true ? {} : report(writeNew);
  check(
    "новый файл отмечен как созданный",
    writeNewBody.existed === false && writeNewBody.created === true && writeNewBody.previous === null,
    JSON.stringify(writeNewBody),
  );
  check(
    "созданный промежуточный каталог попал в отчёт",
    Array.isArray(writeNewBody.created_dirs) && writeNewBody.created_dirs.includes("notes"),
    JSON.stringify(writeNewBody.created_dirs),
  );
  check(
    "новый файл действительно на диске",
    existsSync(join(projectDir, "notes", "new.md")) &&
      readFileSync(join(projectDir, "notes", "new.md"), "utf8") === "# заметки\n",
  );

  // Отдельный файл, а не README.md: его читают живые секции ниже.
  const overwriteBefore = "старое содержимое\n";
  writeFileSync(join(projectDir, "overwrite.md"), overwriteBefore);
  const overwrite = await writeFileTool({
    project_dir: projectDir,
    path: "overwrite.md",
    content: "новое содержимое\n",
  });
  check("перезапись существующего файла прошла", overwrite.isError !== true, errText(overwrite));
  const overwriteBody = overwrite.isError === true ? {} : report(overwrite);
  check(
    "файл отмечен как существовавший",
    overwriteBody.existed === true && overwriteBody.created === false,
    JSON.stringify(overwriteBody),
  );
  check(
    "прежнее содержимое доступно в ответе",
    overwriteBody.previous?.content === overwriteBefore,
    JSON.stringify(overwriteBody.previous),
  );
  check(
    "sha256 прежней и новой версии различаются",
    typeof overwriteBody.previous?.sha256 === "string" &&
      overwriteBody.previous.sha256 !== overwriteBody.sha256,
    JSON.stringify(overwriteBody.previous),
  );
  check("unchanged=false при реальной правке", overwriteBody.unchanged === false);
  check(
    "каталогов при перезаписи не создавалось",
    Array.isArray(overwriteBody.created_dirs) && overwriteBody.created_dirs.length === 0,
  );
  check(
    "на диске лежит новая версия",
    readFileSync(join(projectDir, "overwrite.md"), "utf8") === "новое содержимое\n",
  );

  const rewriteSame = await writeFileTool({
    project_dir: projectDir,
    path: "overwrite.md",
    content: "новое содержимое\n",
  });
  check(
    "повторная запись того же содержимого даёт unchanged",
    rewriteSame.isError !== true && report(rewriteSame).unchanged === true,
    errText(rewriteSame),
  );

  const noPrevious = await writeFileTool({
    project_dir: projectDir,
    path: "overwrite.md",
    content: "третья версия\n",
    include_previous: false,
  });
  const noPreviousBody = noPrevious.isError === true ? {} : report(noPrevious);
  check(
    "include_previous:false не возвращает прежний текст",
    noPreviousBody.previous?.content === null &&
      typeof noPreviousBody.previous?.omitted_reason === "string",
    JSON.stringify(noPreviousBody.previous),
  );
  check(
    "но метаданные прежней версии остались для аудита",
    typeof noPreviousBody.previous?.sha256 === "string" && noPreviousBody.previous.bytes > 0,
    JSON.stringify(noPreviousBody.previous),
  );

  const writeEmpty = await writeFileTool({
    project_dir: projectDir,
    path: "empty-written.txt",
    content: "",
  });
  check(
    "запись пустой строки создаёт пустой файл",
    writeEmpty.isError !== true &&
      report(writeEmpty).bytes === 0 &&
      readFileSync(join(projectDir, "empty-written.txt"), "utf8") === "",
    errText(writeEmpty),
  );

  const writeTraversal = await writeFileTool({
    project_dir: projectDir,
    path: "../escape.md",
    content: "не должно появиться",
  });
  check("запись через ../ отклонена", writeTraversal.isError === true, errText(writeTraversal));
  check("файл за пределами проекта не создан", existsSync(join(workspace, "escape.md")) === false);

  const writeBig = await writeFileTool({
    project_dir: projectDir,
    path: "too-big.txt",
    content: bigText,
  });
  check(
    "слишком большое содержимое отклонено",
    writeBig.isError === true && /слишком больш/.test(errText(writeBig)),
    errText(writeBig),
  );
  check(
    "при отказе по размеру файл не создаётся",
    existsSync(join(projectDir, "too-big.txt")) === false,
  );

  // Переводы строк не нормализуются: что записали, то и прочитали.
  const crlfText = "первая\r\nвторая\r\n";
  const writeCrlf = await writeFileTool({
    project_dir: projectDir,
    path: "crlf.txt",
    content: crlfText,
  });
  const readCrlf = await readFileTool({ project_dir: projectDir, path: "crlf.txt" });
  const readCrlfBody = readCrlf.isError === true ? {} : report(readCrlf);
  check(
    "round-trip сохраняет содержимое побайтово",
    writeCrlf.isError !== true && readCrlfBody.content === crlfText,
    JSON.stringify(readCrlfBody.content),
  );
  check("CRLF распознан", readCrlfBody.eol === "crlf", `получено: ${readCrlfBody.eol}`);
  check("строки посчитаны", readCrlfBody.lines === 2, `получено: ${readCrlfBody.lines}`);
  check(
    "sha256 чтения совпал с sha256 записи",
    writeCrlf.isError !== true && readCrlfBody.sha256 === report(writeCrlf).sha256,
  );

  console.log("\n2h. Файловые инструменты: листинг дерева проекта");

  // Дерево, на котором проверяется игнор, фильтры и обход. Секция 2f уже
  // насорила своими файлами (big.txt, bin.dat, notes/, crlf.txt, link.md),
  // поэтому проверки пишутся на наличие/отсутствие конкретных путей, а не на
  // точные значения count.
  mkdirSync(join(projectDir, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(projectDir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(projectDir, ".git"), { recursive: true });
  writeFileSync(join(projectDir, ".git", "config"), "[core]\n");
  mkdirSync(join(projectDir, "dist"), { recursive: true });
  writeFileSync(join(projectDir, "dist", "bundle.js"), "console.log(1)\n");
  mkdirSync(join(projectDir, "src", "util"), { recursive: true });
  writeFileSync(join(projectDir, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(join(projectDir, "src", "util", "helper.ts"), "export const b = 2;\n");
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "guide.md"), "# guide\n");
  const claudeMdText = "# claude\n";
  writeFileSync(join(projectDir, "CLAUDE.md"), claudeMdText);
  writeFileSync(join(projectDir, "keep.txt"), "keep\n");
  writeFileSync(join(projectDir, "secret.txt"), "secret\n");
  writeFileSync(join(projectDir, "debug.log"), "log\n");
  mkdirSync(join(projectDir, "tmp"), { recursive: true });
  writeFileSync(join(projectDir, "tmp", "x.txt"), "x\n");
  writeFileSync(join(projectDir, ".gitignore"), "secret.txt\n*.log\ntmp/\n");

  // Симлинк-петля: каталог, ссылающийся на корень проекта. Обход обязан её
  // пережить — иначе весь smoke зависнет.
  mkdirSync(join(projectDir, "loopdir"), { recursive: true });
  let loopMade = false;
  try {
    symlinkSync(projectDir, join(projectDir, "loopdir", "self"), "dir");
    loopMade = true;
  } catch {
    // На Windows симлинк требует прав — проверку молча пропускаем.
  }

  const listTool = (args) => client.callTool({ name: "list_project_files", arguments: args });
  const paths = (body) => (body.entries ?? []).map((e) => e.path);

  const rootList = await listTool({ project_dir: projectDir });
  check("листинг корня прошёл", rootList.isError !== true, errText(rootList));
  const rootBody = rootList.isError === true ? { entries: [] } : report(rootList);
  const rootPaths = paths(rootBody);
  check(
    "в листинге корня есть CLAUDE.md и src",
    rootPaths.includes("CLAUDE.md") && rootPaths.includes("src"),
    rootPaths.join(", "),
  );

  check(
    "пути POSIX и относительны project_dir",
    rootPaths.length > 0 &&
      rootPaths.every((p) => !p.includes("\\") && !p.startsWith("/") && !p.includes(":")),
    rootPaths.join(", "),
  );

  const srcEntry = (rootBody.entries ?? []).find((e) => e.path === "src");
  check(
    "каталог в списке: is_dir, size 0, парсящийся mtime",
    srcEntry?.is_dir === true &&
      srcEntry.size === 0 &&
      Number.isFinite(Date.parse(srcEntry?.mtime ?? "")),
    JSON.stringify(srcEntry),
  );

  const claudeEntry = (rootBody.entries ?? []).find((e) => e.path === "CLAUDE.md");
  check(
    "у файла реальный size и is_dir:false",
    claudeEntry?.is_dir === false &&
      claudeEntry.is_symlink === false &&
      claudeEntry.size === Buffer.byteLength(claudeMdText, "utf8"),
    JSON.stringify(claudeEntry),
  );

  const rootAgain = report(await listTool({ project_dir: projectDir }));
  check(
    "порядок стабилен между вызовами",
    JSON.stringify(paths(rootAgain)) === JSON.stringify(rootPaths),
  );

  const iSrc = rootPaths.indexOf("src");
  const iApp = rootPaths.indexOf("src/app.ts");
  const iUtil = rootPaths.indexOf("src/util");
  const iHelper = rootPaths.indexOf("src/util/helper.ts");
  check(
    "порядок — pre-order, дети по алфавиту",
    iSrc !== -1 && iSrc < iApp && iApp < iUtil && iUtil < iHelper,
    `src=${iSrc} app=${iApp} util=${iUtil} helper=${iHelper}`,
  );

  const srcList = report(await listTool({ project_dir: projectDir, path: "src" }));
  const srcPaths = paths(srcList);
  check(
    "листинг подкаталога отдаёт только его поддерево",
    srcPaths.includes("src/app.ts") &&
      srcPaths.includes("src/util/helper.ts") &&
      !srcPaths.includes("CLAUDE.md"),
    srcPaths.join(", "),
  );
  check("запрошенный path отражён в ответе", srcList.path === "src", srcList.path);

  const shallow = report(await listTool({ project_dir: projectDir, recursive: false }));
  const shallowPaths = paths(shallow);
  check(
    "recursive:false даёт только первый уровень",
    shallowPaths.includes("src") && !shallowPaths.includes("src/app.ts"),
    shallowPaths.join(", "),
  );
  check(
    "рекурсия по умолчанию находит вложенный файл",
    rootPaths.includes("src/util/helper.ts"),
  );

  check(
    ".gitignore исключает secret.txt, *.log и tmp/",
    !rootPaths.includes("secret.txt") &&
      !rootPaths.includes("debug.log") &&
      !rootPaths.includes("tmp") &&
      !rootPaths.includes("tmp/x.txt") &&
      rootPaths.includes("keep.txt"),
    rootPaths.join(", "),
  );

  const noGitignorePaths = paths(
    report(await listTool({ project_dir: projectDir, use_gitignore: false })),
  );
  check(
    "use_gitignore:false возвращает скрытое .gitignore",
    noGitignorePaths.includes("secret.txt") &&
      noGitignorePaths.includes("debug.log") &&
      noGitignorePaths.includes("tmp/x.txt"),
    noGitignorePaths.join(", "),
  );

  check(
    "дефолтный игнор убирает node_modules и dist без всякого .gitignore",
    !rootPaths.includes("node_modules") &&
      !rootPaths.includes("node_modules/pkg/index.js") &&
      !rootPaths.includes("dist") &&
      !rootPaths.includes("dist/bundle.js"),
    rootPaths.join(", "),
  );

  const noDefaults = report(await listTool({ project_dir: projectDir, use_default_ignores: false }));
  const noDefaultsPaths = paths(noDefaults);
  const gitPaths = (list) => list.filter((p) => p === ".git" || p.startsWith(".git/"));
  check(
    ".git не появляется ни при каких флагах",
    gitPaths(rootPaths).length === 0 && gitPaths(noDefaultsPaths).length === 0,
    gitPaths(noDefaultsPaths).join(", "),
  );
  check(
    "use_default_ignores:false показывает node_modules",
    noDefaultsPaths.includes("node_modules/pkg/index.js"),
    noDefaultsPaths.join(", "),
  );

  const ignoreDocsPaths = paths(
    report(await listTool({ project_dir: projectDir, ignore: ["docs"] })),
  );
  check(
    "пользовательский ignore убирает каталог",
    !ignoreDocsPaths.includes("docs") &&
      !ignoreDocsPaths.includes("docs/guide.md") &&
      ignoreDocsPaths.includes("CLAUDE.md"),
    ignoreDocsPaths.join(", "),
  );

  const ignoreTsPaths = paths(
    report(await listTool({ project_dir: projectDir, ignore: ["*.ts"] })),
  );
  check(
    "пользовательский паттерн со звёздочкой работает",
    !ignoreTsPaths.includes("src/app.ts") &&
      !ignoreTsPaths.includes("src/util/helper.ts") &&
      ignoreTsPaths.includes("src"),
    ignoreTsPaths.join(", "),
  );

  const negation = await listTool({ project_dir: projectDir, ignore: ["!keep.txt"] });
  check(
    "отрицание в ignore отклонено понятной ошибкой",
    negation.isError === true && /отрицани/.test(errText(negation)),
    errText(negation),
  );

  const limited = report(await listTool({ project_dir: projectDir, limit: 3 }));
  check(
    "лимит усекает частичным ответом, а не ошибкой",
    limited.count === 3 &&
      limited.entries.length === 3 &&
      limited.truncated === true &&
      limited.truncated_reason === "limit",
    JSON.stringify({
      count: limited.count,
      truncated: limited.truncated,
      reason: limited.truncated_reason,
    }),
  );
  check(
    "next_step при усечении подсказывает сузить область",
    typeof limited.next_step === "string" && /сузьте/i.test(limited.next_step),
    limited.next_step ?? "(пусто)",
  );
  check("без лимита truncated:false", rootBody.truncated === false, String(rootBody.truncated));

  const byNamePaths = paths(
    report(await listTool({ project_dir: projectDir, name_contains: "claude" })),
  );
  check(
    "name_contains находит CLAUDE.md без учёта регистра",
    byNamePaths.includes("CLAUDE.md"),
    byNamePaths.join(", "),
  );

  const bySrcPaths = paths(
    report(await listTool({ project_dir: projectDir, name_contains: "src" })),
  );
  check(
    "name_contains ищет в имени, а не в пути",
    !bySrcPaths.includes("src/app.ts") && !bySrcPaths.includes("src/util/helper.ts"),
    bySrcPaths.join(", "),
  );

  const byExt = report(await listTool({ project_dir: projectDir, extensions: ["md"] }));
  const byExtPaths = paths(byExt);
  check(
    "extensions отбирает только .md",
    byExtPaths.includes("CLAUDE.md") &&
      byExtPaths.includes("docs/guide.md") &&
      byExtPaths.length > 0 &&
      byExtPaths.every((p) => p.endsWith(".md")),
    byExtPaths.join(", "),
  );
  const byExtDotPaths = paths(
    report(await listTool({ project_dir: projectDir, extensions: [".md"] })),
  );
  check(
    "точка в extensions необязательна",
    JSON.stringify(byExtDotPaths) === JSON.stringify(byExtPaths),
    byExtDotPaths.join(", "),
  );
  check(
    "при фильтре каталогов в выдаче нет",
    byExt.entries.every((e) => e.is_dir === false) &&
      byExt.filtered === true &&
      byExt.dir_count === 0,
    JSON.stringify({ filtered: byExt.filtered, dir_count: byExt.dir_count }),
  );

  const listTraversal = await listTool({ project_dir: projectDir, path: "../.." });
  check("листинг через ../ отклонён", listTraversal.isError === true, errText(listTraversal));
  const listTraversalInner = await listTool({
    project_dir: projectDir,
    path: "docs/../../secret",
  });
  check(
    "обход внутри строки пути отклонён",
    listTraversalInner.isError === true,
    errText(listTraversalInner),
  );

  const listAbs = await listTool({ project_dir: projectDir, path: join(projectDir, "src") });
  check("абсолютный path отклонён", listAbs.isError === true, errText(listAbs));
  const listOutsideRoot = await listTool({
    project_dir: process.platform === "win32" ? "C:\\Windows" : "/etc",
  });
  check(
    "project_dir вне белого списка отклонён",
    listOutsideRoot.isError === true,
    errText(listOutsideRoot),
  );

  if (symlinkMade) {
    const linkEntry = (rootBody.entries ?? []).find((e) => e.path === "link.md");
    check(
      "симлинка показана записью с is_symlink и size 0",
      linkEntry?.is_symlink === true && linkEntry.is_dir === false && linkEntry.size === 0,
      JSON.stringify(linkEntry),
    );
    check(
      "цель симлинки наружу в ответ не попала",
      !JSON.stringify(rootBody).includes("/etc/hosts"),
    );
  }

  if (loopMade) {
    // Сам факт возврата и есть проверка: при спуске в симлинку обход зациклился
    // бы и smoke не дошёл бы до этой строки.
    const loopEntry = (rootBody.entries ?? []).find((e) => e.path === "loopdir/self");
    check(
      "симлинк-петля показана записью, но внутрь обход не пошёл",
      loopEntry?.is_symlink === true && !rootPaths.some((p) => p.includes("self/")),
      rootPaths.filter((p) => p.includes("self")).join(", "),
    );
  }

  const fileTarget = report(await listTool({ project_dir: projectDir, path: "CLAUDE.md" }));
  check(
    "path на файл даёт список из одной записи",
    fileTarget.count === 1 &&
      fileTarget.entries[0]?.path === "CLAUDE.md" &&
      fileTarget.entries[0]?.is_dir === false &&
      fileTarget.truncated === false,
    JSON.stringify(fileTarget.entries),
  );

  const inIgnoredPaths = paths(
    report(await listTool({ project_dir: projectDir, path: "node_modules" })),
  );
  check(
    "явно запрошенный игнорируемый каталог показывается",
    inIgnoredPaths.includes("node_modules/pkg/index.js"),
    inIgnoredPaths.join(", "),
  );

  const listMissing = await listTool({ project_dir: projectDir, path: "нет-такого-каталога" });
  check(
    "несуществующий path даёт ошибку, а не пустой список",
    listMissing.isError === true && /путь не найден/.test(errText(listMissing)),
    errText(listMissing),
  );

  const logLines = readFileSync(join(workspace, "logs", "ccc-mcp.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  check("событие file_read попало в лог", logLines.some((l) => l.event === "file_read"));
  check("событие file_write попало в лог", logLines.some((l) => l.event === "file_write"));
  check(
    "событие file_list попало в лог с count и truncated",
    logLines.some(
      (l) =>
        l.event === "file_list" &&
        typeof l.count === "number" &&
        typeof l.truncated === "boolean",
    ),
  );
  check(
    "в логе есть sha256 до и после записи",
    logLines.some(
      (l) =>
        l.event === "file_write" &&
        typeof l.sha256 === "string" &&
        typeof l.previous_sha256 === "string",
    ),
  );
  const logDump = JSON.stringify(logLines);
  check(
    "содержимое файлов в лог не попало",
    !logDump.includes("старое содержимое") &&
      !logDump.includes("новое содержимое") &&
      !logDump.includes("третья версия") &&
      !logDump.includes("заметки") &&
      !logDump.includes("первая"),
  );
  check(
    "список путей из листинга в лог не попал",
    !logDump.includes("src/util/helper.ts") && !logDump.includes("docs/guide.md"),
  );

  // Юнит-уровень: сам резолвер путей, без клиента.
  // allowedRoots сервер хранит после realpath — повторяем это и здесь,
  // иначе на macOS /var против /private/var не совпадёт.
  const realWorkspace = realpathSync.native(workspace);
  let resolveRejected = 0;
  for (const bad of ["../outside", "/etc/hosts", "   "]) {
    try {
      resolveProjectFile(projectDir, bad, [realWorkspace]);
    } catch {
      resolveRejected++;
    }
  }
  check(
    "resolveProjectFile отклоняет ../, абсолютный и пустой path",
    resolveRejected === 3,
    `отклонено: ${resolveRejected} из 3`,
  );

  const pendingFile = resolveProjectFile(projectDir, "ещё-нет/файла.md", [realWorkspace]);
  check(
    "для будущего файла возвращается exists:false, а не ошибка",
    pendingFile.exists === false && pendingFile.relative === "ещё-нет/файла.md",
    JSON.stringify(pendingFile),
  );

  const dirEntry = resolveProjectEntry(projectDir, "src", [realWorkspace]);
  check(
    "resolveProjectEntry принимает каталог, в отличие от resolveProjectFile",
    dirEntry.isDir === true && dirEntry.exists === true && dirEntry.relative === "src",
    JSON.stringify(dirEntry),
  );
  let entryRejected = 0;
  for (const bad of ["../outside", "/etc/hosts", "   "]) {
    try {
      resolveProjectEntry(projectDir, bad, [realWorkspace]);
    } catch {
      entryRejected++;
    }
  }
  check(
    "resolveProjectEntry отклоняет ../, абсолютный и пустой path",
    entryRejected === 3,
    `отклонено: ${entryRejected} из 3`,
  );

  console.log("\n2i. Git-инструмент: операции напрямую");

  // Юнит-уровень валидатора имён веток работает и без установленного git.
  const goodBranchNames = ["feature/one", "v1.2.3", "a_b-c", "main", "release/2024.01"];
  const badBranchNames = [
    "-x",
    "--upload-pack=touch /tmp/x",
    "..",
    "a..b",
    "x/",
    "//a",
    "x.lock",
    "HEAD",
    "a b",
    "a~1",
    "a^",
    "x:y",
    "",
    "ветка",
  ];
  check(
    "isValidBranchName пропускает нормальные имена",
    goodBranchNames.every(isValidBranchName),
    `отвергнуты: ${goodBranchNames.filter((n) => !isValidBranchName(n)).join(", ")}`,
  );
  check(
    "isValidBranchName отвергает похожие на флаги и некорректные",
    badBranchNames.every((n) => !isValidBranchName(n)),
    `пропущены: ${badBranchNames.filter(isValidBranchName).join(", ")}`,
  );

  const gitAvailable =
    spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

  if (!gitAvailable) {
    console.log("  пропуск: git недоступен в PATH, проверки run_git не выполнялись");
  } else {
    const gitRepo = join(workspace, "gitrepo");
    mkdirSync(gitRepo);

    const git = (args) => spawnSync("git", args, { cwd: gitRepo, encoding: "utf8" });

    git(["init"]);
    // symbolic-ref вместо `init -b main`: работает на любой версии git.
    git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(["config", "user.email", "smoke@example.com"]);
    git(["config", "user.name", "ccc-mcp smoke"]);
    // Иначе смоук падает на машине с включённой подписью коммитов или с глобальным
    // core.hooksPath: и то и другое к проверяемому поведению отношения не имеет.
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "core.hooksPath", join(workspace, "нет-таких-хуков")]);

    const gitTool = (args) =>
      client.callTool({ name: "run_git", arguments: { project_dir: gitRepo, ...args } });

    const logEmpty = await gitTool({ operation: "log" });
    check(
      "log на репозитории без коммитов: ответ git, а не ошибка вызова",
      logEmpty.isError !== true && report(logEmpty).success === false,
      errText(logEmpty),
    );

    writeFileSync(join(gitRepo, "a.txt"), "первая строка\n");
    writeFileSync(join(gitRepo, "b.txt"), "второй файл\n");

    const statusDirty = report(await gitTool({ operation: "status" }));
    check(
      "status на грязном дереве видит неотслеживаемые файлы",
      statusDirty.clean === false &&
        statusDirty.files.some((f) => f.path === "a.txt" && f.status === "untracked"),
      JSON.stringify(statusDirty.files),
    );

    const commit1 = report(
      await gitTool({ operation: "add_commit", paths: ["a.txt", "b.txt"], message: "первый коммит" }),
    );
    check(
      "add_commit нескольких файлов создал коммит",
      commit1.success === true && /^[0-9a-f]{40}$/.test(commit1.commit?.hash ?? ""),
      JSON.stringify(commit1.next_step),
    );
    check(
      "в ответе перечислено, что реально вошло в коммит",
      commit1.files.length === 2 && commit1.files.every((f) => f.status === "added"),
      JSON.stringify(commit1.files),
    );

    const statusClean = report(await gitTool({ operation: "status" }));
    check(
      "status на чистом дереве",
      statusClean.clean === true && statusClean.count === 0 && statusClean.branch === "main",
      JSON.stringify(statusClean),
    );

    writeFileSync(join(gitRepo, "a.txt"), "первая строка\nвторая строка\n");

    const statusScoped = report(await gitTool({ operation: "status", path: "b.txt" }));
    check(
      "status с path не показывает чужие изменения",
      statusScoped.count === 0,
      JSON.stringify(statusScoped.files),
    );
    const statusOwn = report(await gitTool({ operation: "status", path: "a.txt" }));
    check(
      "status с path видит изменение своего файла",
      statusOwn.count === 1 && statusOwn.files[0]?.status === "modified",
      JSON.stringify(statusOwn.files),
    );

    const diffUnstaged = report(await gitTool({ operation: "diff" }));
    check(
      "diff показывает незастейдженное изменение",
      diffUnstaged.staged === false && diffUnstaged.diff.includes("+вторая строка"),
      JSON.stringify(diffUnstaged.diff.slice(0, 200)),
    );

    git(["add", "a.txt"]);
    const diffStaged = report(await gitTool({ operation: "diff", staged: true }));
    check(
      "diff со staged показывает индекс",
      diffStaged.staged === true && diffStaged.diff.includes("+вторая строка"),
      JSON.stringify(diffStaged.diff.slice(0, 200)),
    );
    const diffAfterAdd = report(await gitTool({ operation: "diff" }));
    check(
      "diff без staged после git add пуст",
      diffAfterAdd.diff === "",
      JSON.stringify(diffAfterAdd.diff.slice(0, 200)),
    );
    const diffStat = report(await gitTool({ operation: "diff", staged: true, stat: true }));
    check(
      "diff со stat даёт сводку, а не патч",
      diffStat.stat === true && diffStat.diff.includes("a.txt") && !diffStat.diff.includes("@@"),
      JSON.stringify(diffStat.diff.slice(0, 200)),
    );

    report(await gitTool({ operation: "add_commit", paths: ["a.txt"], message: "второй коммит" }));
    writeFileSync(join(gitRepo, "b.txt"), "второй файл\nдобавка\n");
    report(await gitTool({ operation: "add_commit", paths: ["b.txt"], message: "третий коммит" }));

    const logLimited = report(await gitTool({ operation: "log", limit: 2 }));
    check(
      "log с limit отдаёт ровно limit последних коммитов",
      logLimited.count === 2 && logLimited.commits[0]?.subject === "третий коммит",
      JSON.stringify(logLimited.commits.map((c) => c.subject)),
    );
    check(
      "поля коммита разобраны, а не отданы сырым текстом",
      /^[0-9a-f]{40}$/.test(logLimited.commits[0]?.hash ?? "") &&
        Number.isFinite(Date.parse(logLimited.commits[0]?.date ?? "")) &&
        logLimited.commits[0]?.author_name === "ccc-mcp smoke",
      JSON.stringify(logLimited.commits[0]),
    );

    const logScoped = report(await gitTool({ operation: "log", path: "a.txt" }));
    check(
      "log с path показывает только коммиты этого файла",
      logScoped.count === 2 && logScoped.commits.every((c) => c.subject !== "третий коммит"),
      JSON.stringify(logScoped.commits.map((c) => c.subject)),
    );

    writeFileSync(
      join(gitRepo, "a.txt"),
      "первая строка\n" + "длинная строка для раздувания диффа\n".repeat(300),
    );
    const diffBig = report(await gitTool({ operation: "diff" }));
    check(
      "большой дифф обрезается, но это не ошибка",
      diffBig.success === true && diffBig.truncated === true && diffBig.bytes <= 2048,
      `truncated: ${diffBig.truncated}, bytes: ${diffBig.bytes}`,
    );
    check(
      "подсказка при обрезке предлагает сузить область",
      /maxDiffBytes/.test(diffBig.next_step) && /stat/.test(diffBig.next_step),
      diffBig.next_step,
    );
    git(["checkout", "--", "a.txt"]);

    const branchCreated = report(await gitTool({ operation: "branch_create", name: "feature/one" }));
    check(
      "branch_create создал ветку, не переключаясь",
      branchCreated.success === true &&
        branchCreated.checked_out === false &&
        /^[0-9a-f]{40}$/.test(branchCreated.head ?? ""),
      JSON.stringify(branchCreated),
    );
    const listAfterCreate = report(await gitTool({ operation: "branch_list" }));
    check(
      "новая ветка видна в списке, текущая не сменилась",
      listAfterCreate.branches.some((b) => b.name === "feature/one") &&
        listAfterCreate.current === "main",
      JSON.stringify(listAfterCreate.branches.map((b) => b.name)),
    );

    const branchFrom = report(
      await gitTool({ operation: "branch_create", name: "from-feature", from: "feature/one" }),
    );
    check(
      "branch_create с from растёт от указанной ветки",
      branchFrom.head === git(["rev-parse", "refs/heads/feature/one"]).stdout.trim(),
      JSON.stringify(branchFrom.head),
    );

    const branchWithCheckout = report(
      await gitTool({ operation: "branch_create", name: "feature/two", checkout: true }),
    );
    check(
      "branch_create с checkout сразу переключает HEAD",
      branchWithCheckout.checked_out === true,
      JSON.stringify(branchWithCheckout),
    );
    const listNow = report(await gitTool({ operation: "branch_list" }));
    check(
      "branch_list перечислил все ветки и отметил ровно одну текущую",
      listNow.count === 4 &&
        listNow.current === "feature/two" &&
        listNow.branches.filter((b) => b.head).length === 1,
      JSON.stringify(listNow.branches.map((b) => `${b.head ? "*" : " "}${b.name}`)),
    );

    const switched = report(await gitTool({ operation: "checkout_branch", name: "main" }));
    check(
      "checkout_branch переключил и запомнил прежнюю ветку",
      switched.success === true &&
        switched.branch === "main" &&
        switched.previous_branch === "feature/two",
      JSON.stringify(switched),
    );

    // Главная проверка защиты от инъекции: метасимволы должны остаться текстом.
    // Команды намеренно безобидные, но с наблюдаемым следом: если бы строка
    // куда-то попала как shell, файлы-улики были бы созданы.
    const pwnA = join(workspace, "ccc-pwn-a");
    const pwnB = join(workspace, "ccc-pwn-b");
    const trickyMessage =
      `it's "tricky" $(whoami) \`id\` ; touch ${pwnA} && echo $HOME | tee ${pwnB}\n` +
      `вторая строка тела`;
    writeFileSync(join(gitRepo, "tricky.txt"), "спецсимволы в сообщении\n");
    const trickyCommit = report(
      await gitTool({ operation: "add_commit", paths: ["tricky.txt"], message: trickyMessage }),
    );
    check(
      "коммит с кавычками, $( ), backtick и ; прошёл",
      trickyCommit.success === true,
      JSON.stringify(trickyCommit.next_step),
    );
    const storedMessage = git(["log", "-1", "--format=%B"]).stdout.replace(/\n+$/, "");
    check(
      "сообщение сохранено байт в байт, подстановки не было",
      storedMessage === trickyMessage,
      JSON.stringify(storedMessage),
    );
    check(
      "следов выполнения команд из сообщения нет",
      !existsSync(pwnA) && !existsSync(pwnB),
    );

    writeFileSync(join(gitRepo, "-rf.txt"), "имя файла похоже на флаг\n");
    const dashFile = report(
      await gitTool({ operation: "add_commit", paths: ["-rf.txt"], message: "файл с дефисом" }),
    );
    check(
      "файл с ведущим дефисом коммитится: пути идут после --",
      dashFile.success === true && dashFile.files.some((f) => f.path === "-rf.txt"),
      JSON.stringify(dashFile.next_step),
    );

    const nothingToCommit = await gitTool({
      operation: "add_commit",
      paths: ["a.txt"],
      message: "коммитить нечего",
    });
    const nothingBody = report(nothingToCommit);
    check(
      "нечего коммитить — это ответ git, а не ошибка вызова",
      nothingToCommit.isError !== true &&
        nothingBody.success === false &&
        nothingBody.git_exit_code === 1,
      JSON.stringify(nothingBody),
    );
    check(
      "в ответе есть родное сообщение git",
      /nothing to commit|nothing added/.test(
        `${nothingBody.git_stdout ?? ""}${nothingBody.git_stderr ?? ""}`,
      ),
      JSON.stringify(nothingBody.next_step),
    );

    const outsidePath = await gitTool({
      operation: "add_commit",
      paths: ["../outside.txt"],
      message: "наружу",
    });
    check(
      "путь за пределы project_dir отклонён",
      outsidePath.isError === true,
      errText(outsidePath),
    );

    const noSuchBranch = await gitTool({ operation: "checkout_branch", name: "no-such-branch" });
    check(
      "checkout на несуществующую ветку даёт понятную ошибку",
      noSuchBranch.isError === true && /ветка не найдена/.test(errText(noSuchBranch)),
      errText(noSuchBranch),
    );

    const dupBranch = await gitTool({ operation: "branch_create", name: "main" });
    check(
      "branch_create с занятым именем даёт понятную ошибку",
      dupBranch.isError === true && /уже существует/.test(errText(dupBranch)),
      errText(dupBranch),
    );

    const pwnBranch = join(workspace, "ccc-pwn-branch");
    const flagBranch = await gitTool({
      operation: "branch_create",
      name: `--upload-pack=touch ${pwnBranch}`,
    });
    check(
      "имя ветки, похожее на флаг, отклонено",
      flagBranch.isError === true && /недопустимое имя ветки/.test(errText(flagBranch)),
      errText(flagBranch),
    );
    check("побочного эффекта от имени-флага нет", !existsSync(pwnBranch));

    const dashBranch = await gitTool({ operation: "checkout_branch", name: "-f" });
    check(
      "имя ветки -f отклонено",
      dashBranch.isError === true && /недопустимое имя ветки/.test(errText(dashBranch)),
      errText(dashBranch),
    );

    const notRepo = join(workspace, "notrepo");
    mkdirSync(notRepo);
    const notRepoRes = await client.callTool({
      name: "run_git",
      arguments: { project_dir: notRepo, operation: "status" },
    });
    check(
      "не git-репозиторий даёт понятную ошибку до вызова git",
      notRepoRes.isError === true && /не git-репозиторий/.test(errText(notRepoRes)),
      errText(notRepoRes),
    );

    // Ключевая проверка границы: без неё git поднялся бы к корню репозитория
    // выше по дереву и работал бы с ним мимо project_dir.
    mkdirSync(join(gitRepo, "sub"));
    const subDirRes = await client.callTool({
      name: "run_git",
      arguments: { project_dir: join(gitRepo, "sub"), operation: "status" },
    });
    check(
      "подкаталог репозитория отклонён: нужен именно корень",
      subDirRes.isError === true && /не git-репозиторий/.test(errText(subDirRes)),
      errText(subDirRes),
    );

    const gitOutsideRoot = await client.callTool({
      name: "run_git",
      arguments: {
        project_dir: process.platform === "win32" ? "C:\\Windows" : "/etc",
        operation: "status",
      },
    });
    check(
      "project_dir вне белого списка отклонён",
      gitOutsideRoot.isError === true,
      errText(gitOutsideRoot),
    );

    const forbiddenOp = await client.callTool({
      name: "run_git",
      arguments: { project_dir: gitRepo, operation: "push" },
    });
    check(
      "операции push нет среди вариантов схемы",
      forbiddenOp.isError === true,
      errText(forbiddenOp),
    );

    const missingName = await gitTool({ operation: "branch_create" });
    check(
      "отсутствие обязательного параметра названо прямо",
      missingName.isError === true && /требует параметр name/.test(errText(missingName)),
      errText(missingName),
    );

    const extraParam = await gitTool({ operation: "status", message: "лишний" });
    check(
      "лишний параметр отклонён, а не проигнорирован",
      extraParam.isError === true && /не применим к операции status/.test(errText(extraParam)),
      errText(extraParam),
    );

    const gitLogLines = readFileSync(join(workspace, "logs", "ccc-mcp.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const gitEvents = gitLogLines.filter((l) => l.event === "git_op");
    check("событие git_op попало в лог", gitEvents.length > 0);
    const commitEvent = gitEvents.find((l) => l.operation === "add_commit" && l.success === true);
    check(
      "в логе add_commit есть хеш, счётчики и выжимка сообщения",
      typeof commitEvent?.commit === "string" &&
        typeof commitEvent?.message_preview === "string" &&
        typeof commitEvent?.path_count === "number",
      JSON.stringify(commitEvent),
    );
    const gitDump = JSON.stringify(gitLogLines);
    check(
      "содержимое диффа в лог не попало",
      !gitDump.includes("длинная строка для раздувания"),
    );
    check("пути из add_commit в лог не попали", !gitDump.includes("tricky.txt"));
  }

  console.log("\n2j. waitForJob: раннее пробуждение на запросе разрешения");

  // Job здесь — минимальный литерал: waitForJob читает у него только status,
  // completion и bridge. Настоящая задача потребовала бы живого claude, а
  // проверяется чистая механика ожидания.
  const fakeJob = (bridge, completion = new Promise(() => {})) => ({
    processId: "00000000-0000-0000-0000-000000000000",
    status: "running",
    completion,
    bridge,
  });
  const postLater = (bridge, body, delayMs = 50) => {
    setTimeout(() => {
      hookPost(bridge.url, body).catch(() => {});
    }, delayMs);
  };

  const wakeBridge = await startBridge();
  try {
    const startedAt = Date.now();
    const waiting = waitForJob(fakeJob(wakeBridge), 30, { wakeOnPendingPermission: true });
    // Запрос приходит уже после того, как ожидание встало: раньше эту задержку
    // приходилось пересиживать целиком.
    postLater(wakeBridge, bashCall("npm run deploy"));
    const wakeReason = await waiting;
    const elapsed = Date.now() - startedAt;
    check(
      "новый pending будит ожидание досрочно",
      wakeReason === "pending_permission",
      `причина: ${wakeReason}`,
    );
    check("пробуждение быстрее wait_seconds", elapsed < 2000, `прошло ${elapsed} мс из 30000`);
    check("запрос действительно создан", wakeBridge.pendingCount() === 1);
    const revisionAfterWake = wakeBridge.pendingRevision;
    check("ревизия сдвинулась", revisionAfterWake > 0, String(revisionAfterWake));

    // Повтор известного вызова работы оператору не добавляет: он этот запрос уже
    // видел. Пробуждение здесь выродилось бы в горячий опрос.
    const repeat = waitForJob(fakeJob(wakeBridge), 1, { wakeOnPendingPermission: true });
    postLater(wakeBridge, bashCall("npm run deploy"));
    const repeatReason = await repeat;
    check(
      "повтор известного запроса не будит",
      repeatReason === "timeout",
      `причина: ${repeatReason}`,
    );
    check(
      "ревизия на повторе не двигается",
      wakeBridge.pendingRevision === revisionAfterWake,
      `${revisionAfterWake} → ${wakeBridge.pendingRevision}`,
    );

    // Тот же мост после истёкшего ожидания обязан будить снова: значит подписка
    // была снята в finally, а не осталась висеть.
    const second = waitForJob(fakeJob(wakeBridge), 30, { wakeOnPendingPermission: true });
    postLater(wakeBridge, bashCall("rm -rf ./dist"));
    check("второй новый запрос будит снова", (await second) === "pending_permission");

    // Без флага ожидание обязано досидеть до конца: cancel_task полагается
    // именно на это.
    const ignored = waitForJob(fakeJob(wakeBridge), 1);
    postLater(wakeBridge, bashCall("git push --force"));
    check(
      "без wakeOnPendingPermission пробуждения нет",
      (await ignored) === "timeout",
      `запросов: ${wakeBridge.pendingCount()}`,
    );
  } finally {
    wakeBridge.stopListening();
  }

  // Исчерпание бюджета — тоже повод разбудить: операция уже не состоится, и
  // узнать об этом через полминуты бесполезно.
  const exhaustBridge = await startBridge({ retryBudget: 1 });
  try {
    await hookPost(exhaustBridge.url, bashCall("npm publish"));
    const onExhaust = waitForJob(fakeJob(exhaustBridge), 30, { wakeOnPendingPermission: true });
    postLater(exhaustBridge, bashCall("npm publish"));
    check("исчерпание бюджета будит ожидание", (await onExhaust) === "pending_permission");
    check(
      "запись действительно стала exhausted",
      exhaustBridge.list()[0].decision === "exhausted",
      exhaustBridge.list()[0].decision,
    );
  } finally {
    exhaustBridge.stopListening();
  }

  // Базовые причины выхода: их различает уже не мост, а сама задача.
  check(
    "завершённая задача даёт completed сразу",
    (await waitForJob({ ...fakeJob(null), status: "done" }, 30)) === "completed",
  );
  check(
    "wait_seconds 0 даёт timeout без ожидания",
    (await waitForJob(fakeJob(null), 0, { wakeOnPendingPermission: true })) === "timeout",
  );
  check(
    "завершение задачи даёт completed",
    (await waitForJob(fakeJob(null, Promise.resolve()), 30)) === "completed",
  );
  check(
    "без моста флаг пробуждения безвреден",
    (await waitForJob(fakeJob(null), 1, { wakeOnPendingPermission: true })) === "timeout",
  );

  console.log("\n2k. NdjsonSplitter: разбор потока NDJSON");

  // Единственное место, где smoke читает файл из репозитория, а не из
  // временного workspace: фикстуры — снятые живьём строки stream-json,
  // воспроизвести их в рантайме нечем.
  const fixturesDir = join(root, "scripts", "fixtures");
  const readFixture = (name) => readFileSync(join(fixturesDir, name), "utf8");

  // Скармливает сплиттеру готовые куски и возвращает всё, что он выдал.
  const collect = (chunks, opts = {}) => {
    const events = [];
    const bad = [];
    const splitter = new NdjsonSplitter({
      ...opts,
      onEvent: (ev) => events.push(ev),
      onBadLine: (chars, reason) => bad.push({ chars, reason }),
    });
    for (const chunk of chunks) splitter.push(chunk);
    splitter.flush();
    return { events, bad, types: events.map((e) => e.type), chars: events.map((e) => e.chars) };
  };
  const slice = (text, size) => {
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  };

  const fixtureText = readFixture("stream-denied-retry.ndjson");
  // Эталон считается независимо от сплиттера, самым тупым способом.
  const fixtureLines = fixtureText.split("\n").filter(Boolean);
  const fixtureObjs = fixtureLines.map((line) => JSON.parse(line));
  const whole = collect([fixtureText]);

  check(
    "фикстура одним чанком: число событий совпадает с числом строк",
    whole.events.length === fixtureLines.length,
    `получено: ${whole.events.length} из ${fixtureLines.length}`,
  );
  check(
    "последовательность типов совпадает с эталоном",
    whole.types.join(",") === fixtureObjs.map((o) => o.type).join(","),
  );
  check(
    "длины строк совпадают с эталоном",
    whole.chars.join(",") === fixtureLines.map((l) => l.length).join(","),
  );
  check("плохих строк на чистой фикстуре нет", whole.bad.length === 0, JSON.stringify(whole.bad));

  // Абсолютные утверждения: испорченная или подменённая фикстура обязана
  // валить тест, а не молча менять эталон вместе с результатом.
  check("в фикстуре 62 события", whole.events.length === 62, `получено: ${whole.events.length}`);
  check(
    "первое событие — system/init",
    whole.events[0].type === "system" && whole.events[0].data.subtype === "init",
  );
  check("последнее событие — result", whole.types[whole.types.length - 1] === "result");
  // Фоновые задачи заставляют CLI начинать новый сегмент: init и result
  // приходят по нескольку раз за один процесс.
  check(
    "сегментов init и result по три",
    fixtureObjs.filter((o) => o.subtype === "init").length === 3 &&
      fixtureObjs.filter((o) => o.type === "result").length === 3,
  );
  check(
    "session_id един на весь поток",
    new Set(fixtureObjs.map((o) => o.session_id).filter(Boolean)).size === 1,
  );

  // Главная проверка: результат не зависит от того, как поток нарезан.
  for (const size of [1, 7, 65536]) {
    const got = collect(slice(fixtureText, size));
    check(
      `подача кусками по ${size}: та же последовательность типов`,
      got.types.join(",") === whole.types.join(","),
      `событий: ${got.events.length}`,
    );
    check(
      `подача кусками по ${size}: те же длины строк`,
      got.chars.join(",") === whole.chars.join(","),
    );
    check(`подача кусками по ${size}: плохих строк нет`, got.bad.length === 0);
  }

  const good1 = JSON.stringify({ type: "assistant", n: 1 });
  const good2 = JSON.stringify({ type: "result", n: 2 });

  // Строка сверх предела выбрасывается целиком, и это не должно сбить разбор
  // следующей: именно так доказывается, что буфер не разросся.
  const huge = JSON.stringify({ type: "assistant", pad: "x".repeat(3_000_000) });
  const over = collect([`${good1}\n${huge}\n${good2}\n`]);
  check(
    "слишком длинная строка не даёт события",
    over.types.join(",") === "assistant,result",
    `получено: ${over.types.join(",")}`,
  );
  check(
    "переполнение помечено too_long",
    over.bad.length === 1 && over.bad[0].reason === "too_long",
    JSON.stringify(over.bad),
  );
  check(
    "chars — полная длина строки, а не предел",
    over.bad[0].chars === huge.length,
    `получено: ${over.bad[0].chars}, длина строки ${huge.length}, предел ${MAX_EVENT_LINE_CHARS}`,
  );

  const longish = JSON.stringify({ type: "assistant", pad: "y".repeat(200) });
  const small = collect(slice(`${good1}\n${longish}\n${good2}\n`, 1), { maxLineChars: 64 });
  check(
    "малый предел, посимвольная подача: обе хорошие строки пришли",
    small.types.join(",") === "assistant,result",
    `получено: ${small.types.join(",")}`,
  );
  check(
    "малый предел: одна too_long с полной длиной",
    small.bad.length === 1 && small.bad[0].reason === "too_long" && small.bad[0].chars === longish.length,
    JSON.stringify(small.bad),
  );

  const blanks = `\n\n\n${good1}\n\n\n${good2}\n\n\n`;
  const blankOne = collect([blanks]);
  const blankChar = collect(slice(blanks, 1));
  check(
    "пустые строки не создают лишних событий",
    blankOne.events.length === 2,
    `получено: ${blankOne.events.length}`,
  );
  check("пустые строки не считаются плохими", blankOne.bad.length === 0);
  check(
    "посимвольно пустые строки дают тот же результат",
    blankChar.types.join(",") === blankOne.types.join(",") && blankChar.bad.length === 0,
  );

  // Хвост без завершающего перевода строки: приходит только на flush().
  {
    const events = [];
    const bad = [];
    const splitter = new NdjsonSplitter({
      onEvent: (ev) => events.push(ev),
      onBadLine: (chars, reason) => bad.push({ chars, reason }),
    });
    splitter.push(good1);
    check("хвост без перевода строки ждёт flush", events.length === 0);
    splitter.flush();
    check("flush отдаёт хвост", events.length === 1 && events[0].type === "assistant");
    splitter.flush();
    check("повторный flush ничего не добавляет", events.length === 1 && bad.length === 0);
    splitter.push("{битый");
    splitter.flush();
    check(
      "битый хвост на flush считается unparseable",
      bad.length === 1 && bad[0].reason === "unparseable",
      JSON.stringify(bad),
    );
  }

  // Мусор на stdout в замерах не наблюдался, но разбор обязан его переживать.
  const noise = `[claude-code:unrecognized_model] {"model":"нет такой"}\n{"type":"assistant"\n${good2}\n`;
  const noisy = collect([noise]);
  check(
    "после мусора строка result всё равно разбирается",
    noisy.events.length === 1 && noisy.events[0].type === "result",
    `получено: ${JSON.stringify(noisy.types)}`,
  );
  check(
    "мусор посчитан как unparseable",
    noisy.bad.length === 2 && noisy.bad.every((b) => b.reason === "unparseable"),
    JSON.stringify(noisy.bad),
  );

  for (const name of [
    "stream-denied-retry.ndjson",
    "stream-denied-approved.ndjson",
    "stream-hook-events.ndjson",
  ]) {
    const text = readFixture(name);
    const reference = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).type);
    const one = collect([text]);
    const perChar = collect(slice(text, 1));
    check(
      `${name}: разбор совпадает с эталоном`,
      one.types.join(",") === reference.join(",") && one.bad.length === 0,
      `событий: ${one.events.length}, плохих: ${one.bad.length}`,
    );
    check(
      `${name}: посимвольная подача даёт то же`,
      perChar.types.join(",") === reference.join(",") && perChar.bad.length === 0,
    );
    // Гигиена: санитизация не должна была оставить следов машины.
    check(
      `${name}: локальных путей и адресов не осталось`,
      !/\/Users\/|zrUitc|claude-501|127\.0\.0\.1/.test(text),
    );
    // …и не должна была съесть то, на чём держатся тесты следующих шагов.
    check(`${name}: request_id моста сохранён`, text.includes("b898d1f105d4"));
  }

  console.log("\n2l. JobProgress: состояние задачи, собранное по потоку");

  // Часы фальшивые: своего хода времени у фикстуры нет, а проверять простой и
  // заморозку реальными паузами — медленно и хлопьеобразно.
  const replayProgress = (name, stopAfterLines = Infinity) => {
    let clock = 1_000_000;
    const progress = new JobProgress(clock, () => clock);
    const splitter = new NdjsonSplitter({
      onEvent: (ev) => progress.ingest(ev),
      onBadLine: (chars, reason) => progress.noteBadLine(chars, reason),
    });
    const lines = readFixture(name).split("\n").filter(Boolean);
    let fed = 0;
    for (const line of lines) {
      if (fed >= stopAfterLines) break;
      clock += 1000;
      splitter.push(`${line}\n`);
      fed++;
    }
    splitter.flush();
    return { progress, snapshot: progress.snapshot(clock), lines, fed };
  };

  // Порядок ключей в tools_used зависит от того, кого встретили первым, поэтому
  // сравниваем отсортированным представлением, а не JSON.stringify.
  const sortedCounts = (obj) =>
    Object.entries(obj)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");

  // Абсолютные числа сняты из самих фикстур. Подменённый или испорченный файл
  // обязан валить тест, а не молча съезжать вместе с эталоном.
  const progressExpectations = [
    {
      name: "stream-denied-retry.ndjson",
      sessionId: "00000000-0000-4000-8000-000000000001",
      segments: 3,
      resultEvents: 3,
      assistantEvents: 22,
      assistantTextBlocks: 5,
      thinkingBlocks: 7,
      thinkingTokenEvents: 10,
      toolCalls: 10,
      toolResults: 10,
      toolErrors: 7,
      toolsUsed: "Bash=5,Monitor=4,ToolSearch=1",
      repeats: 3,
      cost: 0.36682950000000003,
      lastIsError: true,
    },
    {
      name: "stream-denied-approved.ndjson",
      sessionId: "00000000-0000-4000-8000-000000000002",
      segments: 2,
      resultEvents: 2,
      assistantEvents: 19,
      assistantTextBlocks: 4,
      thinkingBlocks: 7,
      thinkingTokenEvents: 16,
      toolCalls: 8,
      toolResults: 8,
      toolErrors: 5,
      toolsUsed: "Bash=4,Monitor=3,ToolSearch=1",
      repeats: 2,
      cost: 0.25052050000000003,
      lastIsError: false,
    },
    {
      name: "stream-hook-events.ndjson",
      sessionId: "00000000-0000-4000-8000-000000000003",
      segments: 2,
      resultEvents: 2,
      assistantEvents: 16,
      assistantTextBlocks: 4,
      thinkingBlocks: 5,
      thinkingTokenEvents: 11,
      toolCalls: 7,
      toolResults: 7,
      toolErrors: 4,
      toolsUsed: "Bash=4,Monitor=2,ToolSearch=1",
      repeats: 2,
      cost: 0.210749,
      lastIsError: false,
    },
  ];

  for (const exp of progressExpectations) {
    const { snapshot: snap, lines } = replayProgress(exp.name);
    const short = exp.name.replace(".ndjson", "");

    // 1. Счётчики событий.
    check(
      `${short}: вызовы и результаты инструментов посчитаны`,
      snap.toolCalls === exp.toolCalls &&
        snap.toolResults === exp.toolResults &&
        snap.toolErrors === exp.toolErrors,
      `получено: calls=${snap.toolCalls}, results=${snap.toolResults}, errors=${snap.toolErrors}`,
    );
    check(
      `${short}: события ассистента, текст и рассуждения посчитаны`,
      snap.assistantEvents === exp.assistantEvents &&
        snap.assistantTextBlocks === exp.assistantTextBlocks &&
        snap.thinkingBlocks === exp.thinkingBlocks &&
        snap.thinkingTokenEvents === exp.thinkingTokenEvents,
      `получено: ${snap.assistantEvents}/${snap.assistantTextBlocks}/${snap.thinkingBlocks}/${snap.thinkingTokenEvents}`,
    );
    check(
      `${short}: tools_used совпадает`,
      sortedCounts(snap.toolsUsed) === exp.toolsUsed,
      `получено: ${sortedCounts(snap.toolsUsed)}`,
    );
    check(
      `${short}: сегменты и строки result посчитаны`,
      snap.segments === exp.segments && snap.resultEvents === exp.resultEvents,
      `получено: ${snap.segments}/${snap.resultEvents}`,
    );
    check(
      `${short}: session_id и модель взяты из init`,
      snap.sessionId === exp.sessionId && snap.model === "claude-opus-5",
      `получено: ${snap.sessionId}, ${snap.model}`,
    );
    check(
      `${short}: поток жив, плохих строк нет, незакрытых вызовов нет`,
      snap.streaming === true && snap.badLines === 0 && snap.openToolCalls === 0,
      `получено: streaming=${snap.streaming}, bad=${snap.badLines}, open=${snap.openToolCalls}`,
    );

    // 2. Повторы одного и того же вызова.
    check(
      `${short}: повторов b898d1f105d4 ровно ${exp.repeats}`,
      snap.repeatedCalls["b898d1f105d4"] === exp.repeats,
      `получено: ${snap.repeatedCalls["b898d1f105d4"]}`,
    );
    check(
      `${short}: последний вызов — тот же Bash, попытка ${exp.repeats}`,
      snap.lastToolCall !== null &&
        snap.lastToolCall.name === "Bash" &&
        snap.lastToolCall.requestId === "b898d1f105d4" &&
        snap.lastToolCall.summary === "echo hook-stream-test" &&
        snap.lastToolCall.repeat === exp.repeats,
      JSON.stringify(snap.lastToolCall),
    );

    // 3. Отказ — это завершённый вызов, просто неуспешный.
    check(
      `${short}: последний вызов завершён, is_error=${exp.lastIsError}`,
      snap.lastToolCall.completed === true && snap.lastToolCall.isError === exp.lastIsError,
      JSON.stringify(snap.lastToolCall),
    );

    // 4. Стоимость берётся из последней строки result как есть.
    const lastResultLine = [...lines].reverse().find((l) => JSON.parse(l).type === "result");
    check(
      `${short}: накопленная стоимость равна последней строке result`,
      snap.lastResultCostUsd === JSON.parse(lastResultLine).total_cost_usd &&
        snap.lastResultCostUsd === exp.cost,
      `получено: ${snap.lastResultCostUsd}, ожидалось ${exp.cost}`,
    );

    // 8. Гигиена: содержимое tool_result в снимок не попадает.
    // Сентинелы — фразы из текста отказа, которых модель в своём видимом тексте
    // не повторяет: сам оборот «ЗАПРЕЩЕНО без одобрения оператора» она в
    // stream-denied-retry цитирует сама, поэтому сентинелом он быть не может.
    const serialized = JSON.stringify(snap);
    check(
      `${short}: текст отказа не утёк в снимок`,
      !serialized.includes("НЕ ИЩИ ОБХОДНОЙ ПУТЬ") &&
        !serialized.includes("решение придёт асинхронно") &&
        !serialized.includes("ОБЯЗАТЕЛЬНЫЙ ПОРЯДОК"),
    );
    check(`${short}: подписи рассуждений в снимке нет`, !serialized.includes("signature"));
    check(
      `${short}: кольцо событий ограничено и не хранит длинных текстов`,
      snap.recentEvents.length <= 20 && snap.recentEvents.every((e) => e.text.length <= 201),
      `записей: ${snap.recentEvents.length}`,
    );
  }

  // 3 (продолжение). Отказ уже на первом tool_result помечен как завершённый —
  // иначе детектор зависаний срабатывал бы на каждом отказе хука.
  // 4 (продолжение). До первой строки result стоимость именно null, а не 0.
  const approvedMid = replayProgress("stream-denied-approved.ndjson", 6).snapshot;
  check(
    "на отказе вызов уже completed, но is_error",
    approvedMid.toolCalls === 1 &&
      approvedMid.lastToolCall.completed === true &&
      approvedMid.lastToolCall.isError === true &&
      approvedMid.openToolCalls === 0,
    JSON.stringify(approvedMid.lastToolCall),
  );
  check(
    "до первой строки result стоимость null, а не 0",
    approvedMid.resultEvents === 0 && approvedMid.lastResultCostUsd === null,
    `получено: ${approvedMid.lastResultCostUsd}`,
  );

  // 5. Состояние не сбрасывается на строке result: в stream-denied-retry три
  // повтора одного вызова лежат в трёх разных сегментах.
  const retryMid = replayProgress("stream-denied-retry.ndjson", 39).snapshot;
  const retryFinal = replayProgress("stream-denied-retry.ndjson").snapshot;
  check(
    "на первой строке result накоплено 7 вызовов и 1 повтор",
    retryMid.resultEvents === 1 &&
      retryMid.toolCalls === 7 &&
      retryMid.repeatedCalls["b898d1f105d4"] === 1,
    `получено: results=${retryMid.resultEvents}, calls=${retryMid.toolCalls}, repeats=${retryMid.repeatedCalls["b898d1f105d4"]}`,
  );
  check(
    "к концу потока счётчики выросли, а не обнулились",
    retryFinal.toolCalls === 10 &&
      retryFinal.repeatedCalls["b898d1f105d4"] === 3 &&
      retryFinal.resultEvents === 3 &&
      retryFinal.segments === 3,
    `получено: calls=${retryFinal.toolCalls}, repeats=${retryFinal.repeatedCalls["b898d1f105d4"]}`,
  );

  // 6. Токены агрегируются по уникальному message.id.
  let naiveRead = 0;
  let naiveCreate = 0;
  for (const line of readFixture("stream-denied-retry.ndjson").split("\n").filter(Boolean)) {
    const obj = JSON.parse(line);
    if (obj.type !== "assistant") continue;
    const usage = obj.message?.usage ?? {};
    naiveRead += usage.cache_read_input_tokens ?? 0;
    naiveCreate += usage.cache_creation_input_tokens ?? 0;
  }
  check(
    "кэш-токены посчитаны по уникальным message.id",
    retryFinal.cacheReadInputTokens === 305919 && retryFinal.cacheCreationInputTokens === 15582,
    `получено: ${retryFinal.cacheReadInputTokens}/${retryFinal.cacheCreationInputTokens}`,
  );
  check(
    "наивная сумма по событиям дала бы другое число",
    naiveRead === 507108 && naiveCreate === 30142 && naiveRead !== retryFinal.cacheReadInputTokens,
    `наивно: ${naiveRead}/${naiveCreate}`,
  );

  // 7. Незнакомые типы событий копятся по имени и разбор не ломают.
  const hookEvents = replayProgress("stream-hook-events.ndjson").snapshot;
  check(
    "события --include-hook-events учтены как незнакомые",
    hookEvents.unknownTypes["system/hook_started"] === 3 &&
      hookEvents.unknownTypes["system/hook_response"] === 3 &&
      hookEvents.toolCalls === 7 &&
      hookEvents.badLines === 0,
    JSON.stringify(hookEvents.unknownTypes),
  );
  check(
    "внутренние отказы CLI учтены отдельным типом",
    retryFinal.unknownTypes["system/permission_denied"] === 2 &&
      retryFinal.unknownTypes["system/task_notification"] === 2,
    JSON.stringify(retryFinal.unknownTypes),
  );

  // 8 (продолжение). Видимый текст модели показывается и обрезается.
  check(
    "последнее видимое сообщение сохранено и обрезано",
    retryFinal.lastAssistantText.startsWith("Команда не выполнена") &&
      retryFinal.lastAssistantText.length <= 601,
    `длина: ${retryFinal.lastAssistantText.length}`,
  );
  check(
    "rate_limit разобран",
    retryFinal.rateLimit !== null &&
      retryFinal.rateLimit.status === "allowed" &&
      retryFinal.rateLimit.utilization === 0.12,
    JSON.stringify(retryFinal.rateLimit),
  );

  // 9. Плохие строки копятся в прогрессе, а часы замирают на freeze.
  {
    let clock = 5_000;
    const progress = new JobProgress(clock, () => clock);
    const empty = progress.snapshot();
    check(
      "пустой JobProgress: streaming false, простой не известен",
      empty.streaming === false &&
        empty.lastActivityAt === null &&
        empty.idleSeconds === null &&
        empty.lastToolCall === null &&
        empty.lastResultCostUsd === null &&
        empty.toolCalls === 0,
      JSON.stringify(empty),
    );

    const splitter = new NdjsonSplitter({
      maxLineChars: 64,
      onEvent: (ev) => progress.ingest(ev),
      onBadLine: (chars, reason) => progress.noteBadLine(chars, reason),
    });
    clock = 6_000;
    splitter.push("[claude-code:unrecognized_model] {}\n");
    splitter.push("{битый\n");
    splitter.push(`${JSON.stringify({ type: "assistant", pad: "y".repeat(200) })}\n`);
    splitter.push(`${JSON.stringify({ type: "assistant", message: { id: "m1", content: [] } })}\n`);
    const withBad = progress.snapshot();
    check(
      "плохие строки посчитаны в прогрессе, хорошая разобрана",
      withBad.badLines === 3 &&
        withBad.oversizeLines === 1 &&
        withBad.assistantEvents === 1 &&
        withBad.streaming === true,
      `получено: bad=${withBad.badLines}, too_long=${withBad.oversizeLines}, assistant=${withBad.assistantEvents}`,
    );

    clock = 606_000;
    const running = progress.snapshot();
    check(
      "у идущей задачи простой растёт вместе с часами",
      running.idleSeconds === 600 && running.elapsedMs === 601_000 && running.finishedAt === null,
      `получено: idle=${running.idleSeconds}, elapsed=${running.elapsedMs}`,
    );

    progress.freeze(16_000);
    clock = 1_206_000;
    const frozen = progress.snapshot();
    check(
      "после freeze простой и длительность замерли",
      frozen.idleSeconds === 10 && frozen.elapsedMs === 11_000 && frozen.finishedAt === 16_000,
      `получено: idle=${frozen.idleSeconds}, elapsed=${frozen.elapsedMs}`,
    );
  }

  console.log("\n2m. Раннер в режиме потока: argv, границы буферов, проводка");

  // Дочерний процесс подделывается настоящим node: живой CLI для проверки
  // проводки не нужен, а спавн реального процесса покрывает то, чего подача
  // фикстуры в память не воспроизводит, — произвольные границы чанков, порядок
  // 'end' и 'close' и обратное давление на трубе.
  const feeder =
    "const fs=require('fs');const t=fs.readFileSync(process.argv[1],'utf8');" +
    "for(let i=0;i<t.length;i+=4096)process.stdout.write(t.slice(i,i+4096));";
  const retryPath = join(fixturesDir, "stream-denied-retry.ndjson");
  const retryText = readFixture("stream-denied-retry.ndjson");
  const retryLines = retryText.split("\n").filter(Boolean);
  const retryResults = retryLines.filter((l) => JSON.parse(l).type === "result");

  // Тот же поток, оборванный перед первой строкой result: так выглядит stdout
  // отменённой или отвалившейся по таймауту задачи. Обрезаем именно перед
  // первой, а не после последней, — иначе «последней» стала бы предыдущая.
  const truncatedPath = join(workspace, "stream-no-result.ndjson");
  const truncatedText = `${retryLines
    .slice(0, retryLines.findIndex((l) => JSON.parse(l).type === "result"))
    .join("\n")}\n`;
  writeFileSync(truncatedPath, truncatedText);

  const streamRunnerConfig = {
    claudeBin: process.execPath,
    maxConcurrent: 4,
    sandbox: "off",
    passEnv: [],
  };
  const streamRunner = new ClaudeRunner(streamRunnerConfig, silentLogger);

  const runStream = async (childArgs, opts = {}) => {
    const events = [];
    const bad = [];
    const runOptions = { args: childArgs, cwd: workspace, timeoutMs: 20_000 };
    if (opts.buffered !== true) {
      runOptions.onEvent = (ev) => {
        events.push(ev);
        opts.progress?.ingest(ev);
        if (opts.throwOnEvent) throw new Error("потребитель событий упал");
      };
      runOptions.onBadLine = (chars, reason) => {
        bad.push({ chars, reason });
        opts.progress?.noteBadLine(chars, reason);
      };
    }
    if (opts.warnContext !== undefined) runOptions.warnContext = opts.warnContext;
    const handle = (opts.runner ?? streamRunner).run(runOptions);
    // Отмена посреди потока: единственный способ дойти до ветки killed, а
    // именно она не должна давать записи no_result_line.
    if (opts.cancelAfterMs !== undefined) {
      setTimeout(() => handle.cancel(), opts.cancelAfterMs);
    }
    const outcome = await handle.done;
    return { outcome, events, bad };
  };

  // 1. Выключенный стрим не меняет командную строку ни на байт.
  const argvBase = {
    permissionMode: "plan",
    taskText: "задача",
    appendSystemPrompt: "системная инструкция",
  };
  const argvRunner = new ClaudeRunner({ sandbox: "off" }, silentLogger);
  const legacyArgs = argvRunner.buildTaskArgs({ ...argvBase, stream: false });
  check(
    "stream:false даёт побайтово прежний argv",
    JSON.stringify(legacyArgs) ===
      JSON.stringify([
        "--permission-mode",
        "plan",
        "--disallowedTools",
        "AskUserQuestion",
        "--append-system-prompt",
        "системная инструкция",
        "-p",
        "задача",
        "--output-format",
        "json",
        // Не от стрима: plan-режим всегда выключает auto-режим в планировании.
        "--settings",
        '{"useAutoModeDuringPlan":false}',
      ]),
    JSON.stringify(legacyArgs),
  );

  // 2. Включённый — добавляет ровно stream-json и --verbose.
  const streamArgs = argvRunner.buildTaskArgs({ ...argvBase, stream: true });
  const formatIndex = streamArgs.indexOf("--output-format");
  check(
    "stream:true просит stream-json",
    streamArgs[formatIndex + 1] === "stream-json",
    `получено: ${streamArgs[formatIndex + 1]}`,
  );
  check(
    "--verbose присутствует (без него CLI отвергает stream-json)",
    streamArgs.includes("--verbose"),
    JSON.stringify(streamArgs),
  );
  check("json-формата в argv не осталось", streamArgs.indexOf("json") === -1);
  check(
    "--include-hook-events не добавляется",
    streamArgs.indexOf("--include-hook-events") === -1,
  );
  check(
    "остальная командная строка не изменилась",
    JSON.stringify(streamArgs.slice(0, 8)) === JSON.stringify(legacyArgs.slice(0, 8)),
    JSON.stringify(streamArgs.slice(0, 8)),
  );

  // 3. Наружу уходит одна строка result, а не весь поток.
  const wiredProgress = new JobProgress(1_000_000, () => 1_000_000);
  const streamed = await runStream(["-e", feeder, retryPath], { progress: wiredProgress });
  check(
    "stdout раннера — ровно одна строка",
    streamed.outcome.stdout.split("\n").length === 1 && streamed.outcome.stdout.length > 0,
    `строк: ${streamed.outcome.stdout.split("\n").length}`,
  );
  check(
    "и это последняя строка result потока",
    JSON.parse(streamed.outcome.stdout).total_cost_usd ===
      JSON.parse(retryResults[retryResults.length - 1]).total_cost_usd,
    `получено: ${JSON.parse(streamed.outcome.stdout).total_cost_usd}`,
  );
  check(
    "весь поток в памяти не остался",
    streamed.outcome.stdout.length < retryText.length / 10,
    `${streamed.outcome.stdout.length} из ${retryText.length} символов`,
  );
  check(
    "событий столько же, сколько строк в фикстуре",
    streamed.events.length === retryLines.length && streamed.bad.length === 0,
    `событий: ${streamed.events.length}, плохих строк: ${streamed.bad.length}`,
  );

  // 4. Свойство A0: разбор выхода раннера тождествен разбору строки из файла.
  const parsedFromRunner = parseClaudeOutput({
    stdout: streamed.outcome.stdout,
    stderr: streamed.outcome.stderr,
    exitCode: streamed.outcome.exitCode,
  });
  const parsedFromFixture = parseClaudeOutput({
    stdout: retryResults[retryResults.length - 1],
    stderr: "",
    exitCode: 0,
  });
  check(
    "parseClaudeOutput на выходе раннера даёт то же, что на строке из фикстуры",
    JSON.stringify(parsedFromRunner) === JSON.stringify(parsedFromFixture),
    `parse_error: ${parsedFromRunner.parseError}`,
  );
  check(
    "разбор содержательный: есть session_id, текст и raw",
    typeof parsedFromRunner.sessionId === "string" &&
      typeof parsedFromRunner.resultText === "string" &&
      parsedFromRunner.raw !== null &&
      parsedFromRunner.parseError === null,
  );

  // 5. Проводка в JobProgress: те же числа, что при прямой подаче фикстуры.
  const retryExpectation = progressExpectations[0];
  const wiredSnapshot = wiredProgress.snapshot(1_000_000);
  check(
    "прогресс, наполненный раннером, совпадает с прямой подачей фикстуры",
    wiredSnapshot.toolCalls === retryExpectation.toolCalls &&
      wiredSnapshot.toolResults === retryExpectation.toolResults &&
      wiredSnapshot.assistantEvents === retryExpectation.assistantEvents &&
      wiredSnapshot.segments === retryExpectation.segments &&
      wiredSnapshot.resultEvents === retryExpectation.resultEvents &&
      sortedCounts(wiredSnapshot.toolsUsed) === retryExpectation.toolsUsed &&
      wiredSnapshot.sessionId === retryExpectation.sessionId &&
      wiredSnapshot.lastResultCostUsd === retryExpectation.cost &&
      wiredSnapshot.badLines === 0,
    JSON.stringify({
      toolCalls: wiredSnapshot.toolCalls,
      segments: wiredSnapshot.segments,
      tools: sortedCounts(wiredSnapshot.toolsUsed),
      bad: wiredSnapshot.badLines,
    }),
  );

  // 6. Буферный путь остался ровно прежним.
  const buffered = await runStream(["-e", feeder, retryPath], { buffered: true });
  check(
    "без onEvent stdout копится целиком и побайтово",
    buffered.outcome.stdout === retryText,
    `получено ${buffered.outcome.stdout.length} из ${retryText.length} символов`,
  );

  // 7. stderr больше не растёт без границ.
  const floodLine = `${JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "00000000-0000-4000-8000-0000000000ff",
    result: "готово",
    is_error: false,
  })}\n`;
  const flooded = await runStream([
    "-e",
    `process.stderr.write('s'.repeat(100000));process.stdout.write(${JSON.stringify(floodLine)});`,
  ]);
  check(
    "stderr подрезан до предела",
    flooded.outcome.stderr.length === MAX_STDERR_TAIL,
    `получено: ${flooded.outcome.stderr.length} из 100000`,
  );
  check(
    "сохранён именно хвост stderr",
    flooded.outcome.stderr === "s".repeat(MAX_STDERR_TAIL),
  );
  check(
    "строка result дошла, несмотря на поток в stderr",
    JSON.parse(flooded.outcome.stdout).type === "result",
    flooded.outcome.stdout.slice(0, 120),
  );

  // 8. Поток без строки result: путь отмены и таймаута.
  const noResult = await runStream(["-e", feeder, truncatedPath]);
  check(
    "без строки result наружу уходит ограниченный хвост stdout",
    noResult.outcome.stdout.length > 0 && noResult.outcome.stdout.length <= MAX_STDOUT_TAIL,
    `получено: ${noResult.outcome.stdout.length} символов`,
  );
  check(
    "хвост — это именно конец потока",
    truncatedText.endsWith(noResult.outcome.stdout),
  );
  const parsedNoResult = parseClaudeOutput({
    stdout: noResult.outcome.stdout,
    stderr: "",
    exitCode: 0,
  });
  check(
    "парсер честно сообщает, что итогового JSON не было",
    parsedNoResult.parseError !== null &&
      parsedNoResult.raw === null &&
      parsedNoResult.resultText === null &&
      parsedNoResult.ok === false,
    `parse_error: ${parsedNoResult.parseError}`,
  );

  // 9. Падение потребителя событий не уносит прогон и не спамит в лог.
  const warnings = [];
  const hostile = await runStream(["-e", feeder, retryPath], {
    throwOnEvent: true,
    runner: new ClaudeRunner(streamRunnerConfig, {
      write() {},
      stderr: (message) => warnings.push(message),
    }),
  });
  check(
    "исключение потребителя не ломает прогон",
    JSON.parse(hostile.outcome.stdout).type === "result" &&
      hostile.events.length === retryLines.length,
    `событий: ${hostile.events.length}`,
  );
  check(
    "предупреждение записано ровно один раз",
    warnings.length === 1,
    `записей: ${warnings.length}`,
  );

  // 10. Дрейф формата виден в JSONL: событие stream_warn.
  //
  // Проверяется на логгере-перехватчике, а не на файле лога живого сервера:
  // живой CLI плохих строк не выдаёт (это утверждает отдельная живая проверка),
  // поэтому воспроизвести сбой можно только на поддельном дочернем процессе.
  const recordingRunner = () => {
    const records = [];
    const warnings = [];
    return {
      records,
      warnings,
      warns: () => records.filter((r) => r.event === "stream_warn"),
      runner: new ClaudeRunner(streamRunnerConfig, {
        write: (record) => records.push(record),
        stderr: (message) => warnings.push(message),
      }),
    };
  };
  /** Дочерний процесс, печатающий заданный текст в stdout и выходящий. */
  const emitStdout = (text) => ["-e", `process.stdout.write(${JSON.stringify(text)});`];

  const firstBad = "не json вовсе: секретное-слово-из-плохой-строки";
  const secondBad = '{"оборванный":';
  const badRun = recordingRunner();
  const badProgress = new JobProgress(3_000_000, () => 3_000_000);
  const badStream = await runStream(emitStdout(`${firstBad}\n${secondBad}\n${floodLine}`), {
    runner: badRun.runner,
    progress: badProgress,
    warnContext: () => ({ processId: "p-42", tool: "plan_task", sessionId: "s-77" }),
  });
  const badWarns = badRun.warns();
  check(
    "плохая строка даёт ровно одну запись stream_warn",
    badWarns.length === 1,
    JSON.stringify(badRun.records),
  );
  check(
    "запись называет причину и длину строки",
    badWarns[0]?.reason === "unparseable" &&
      badWarns[0]?.line_chars === firstBad.length &&
      badWarns[0]?.bad_lines === 1,
    JSON.stringify(badWarns[0]),
  );
  check(
    "в записи есть project_dir и контекст задачи",
    badWarns[0]?.project_dir === workspace &&
      badWarns[0]?.process_id === "p-42" &&
      badWarns[0]?.tool === "plan_task" &&
      badWarns[0]?.session_id === "s-77",
    JSON.stringify(badWarns[0]),
  );
  check(
    "содержимое плохой строки в лог не попало",
    !JSON.stringify(badRun.records).includes("секретное-слово-из-плохой-строки"),
    JSON.stringify(badRun.records),
  );
  check(
    "вторая подряд плохая строка второй записи не даёт",
    badWarns.filter((r) => r.reason === "unparseable").length === 1,
    JSON.stringify(badWarns),
  );
  check(
    "при этом счётчик прогресса посчитал обе — подавлен лог, а не счётчик",
    badProgress.snapshot(3_000_000).badLines === 2,
    `получено: ${badProgress.snapshot(3_000_000).badLines}`,
  );
  check(
    "строка result после плохих строк дошла, записи no_result_line нет",
    JSON.parse(badStream.outcome.stdout).type === "result" &&
      badWarns.every((r) => r.reason !== "no_result_line"),
    badStream.outcome.stdout.slice(0, 120),
  );

  // Классы сбоя считаются и логируются раздельно: «формат поехал» и «пришла
  // гигантская строка» — разные диагнозы с разными действиями.
  const mixedRun = recordingRunner();
  const mixedStream = await runStream(
    [
      "-e",
      'process.stdout.write("не json\\n");' +
        'process.stdout.write("{" + "x".repeat(3000000) + "\\n");' +
        `process.stdout.write(${JSON.stringify(floodLine)});`,
    ],
    { runner: mixedRun.runner },
  );
  const mixedWarns = mixedRun.warns();
  check(
    "unparseable и too_long логируются раздельно",
    mixedWarns.length === 2 &&
      mixedWarns
        .map((r) => r.reason)
        .sort()
        .join(",") === "too_long,unparseable",
    JSON.stringify(mixedWarns.map((r) => r.reason)),
  );
  check(
    "запись too_long несёт полную длину строки",
    (mixedWarns.find((r) => r.reason === "too_long")?.line_chars ?? 0) > MAX_EVENT_LINE_CHARS,
    JSON.stringify(mixedWarns.find((r) => r.reason === "too_long")),
  );
  check(
    "строка result дошла и после переполнения",
    JSON.parse(mixedStream.outcome.stdout).type === "result",
  );

  // Строки result не случилось, хотя поток шёл: главный признак дрейфа формата.
  const noResultRun = recordingRunner();
  await runStream(["-e", feeder, truncatedPath], { runner: noResultRun.runner });
  const noResultWarns = noResultRun.warns();
  check(
    "отсутствие строки result даёт запись no_result_line",
    noResultWarns.length === 1 && noResultWarns[0]?.reason === "no_result_line",
    JSON.stringify(noResultWarns),
  );
  check(
    "запись несёт счётчики потока и код выхода",
    noResultWarns[0]?.events > 0 &&
      noResultWarns[0]?.bad_lines === 0 &&
      noResultWarns[0]?.oversize_lines === 0 &&
      noResultWarns[0]?.exit_code === 0 &&
      noResultWarns[0]?.stdout_tail_chars > 0,
    JSON.stringify(noResultWarns[0]),
  );

  // Комбинация «плохие строки были И result не пришёл» — из одной строки лога.
  const driftRun = recordingRunner();
  await runStream(["-e", `process.stdout.write("не json\\n");${feeder}`, truncatedPath], {
    runner: driftRun.runner,
  });
  check(
    "комбинация «плохие строки и нет result» читается из одной записи",
    driftRun.warns().some((r) => r.reason === "no_result_line" && r.bad_lines === 1),
    JSON.stringify(driftRun.warns()),
  );

  // Отмена и таймаут: отсутствие result там ожидаемо, и запись на каждую отмену
  // залила бы лог шумом ровно того класса, от которого событие предупреждает.
  const canceledRun = recordingRunner();
  const canceledStream = await runStream(
    [
      "-e",
      'process.stdout.write("{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\"}\\n");' +
        "setInterval(() => {}, 1000);",
    ],
    { runner: canceledRun.runner, cancelAfterMs: 300 },
  );
  check(
    "отменённый процесс записи stream_warn не даёт",
    canceledStream.outcome.killed === true && canceledRun.warns().length === 0,
    `killed=${canceledStream.outcome.killed}, записей: ${JSON.stringify(canceledRun.warns())}`,
  );

  // Полная тишина — это провал авторизации, модели или спавна, а не дрейф
  // формата: он виден по stderr в записи finish и по паттерну no_progress.
  const silentRun = recordingRunner();
  const silentStream = await runStream(["-e", "process.exit(1);"], { runner: silentRun.runner });
  check(
    "процесс, не выдавший ни строки, записи stream_warn не даёт",
    silentStream.outcome.exitCode === 1 && silentRun.warns().length === 0,
    JSON.stringify(silentRun.warns()),
  );

  const bufferedRun = recordingRunner();
  await runStream(["-e", feeder, truncatedPath], { runner: bufferedRun.runner, buffered: true });
  check(
    "буферный путь (streamEvents: false) записей stream_warn не даёт",
    bufferedRun.warns().length === 0,
    JSON.stringify(bufferedRun.warns()),
  );

  // Та же комбинация в ответе инструмента: подсказка парсера в этом случае
  // отправляет проверять авторизацию, а причина совсем другая.
  check(
    "buildStreamDriftHint молчит, когда поток был чистым",
    buildStreamDriftHint(wiredSnapshot) === null,
    String(buildStreamDriftHint(wiredSnapshot)),
  );
  const driftHint = buildStreamDriftHint(badProgress.snapshot(3_000_000));
  check(
    "buildStreamDriftHint называет число плохих строк и обход",
    typeof driftHint === "string" &&
      driftHint.includes("2") &&
      driftHint.includes("streamEvents: false") &&
      driftHint.includes("stream_warn"),
    String(driftHint),
  );

  console.log("\n2n. detectPatterns: что происходит с идущей задачей");

  // Детектор — чистая функция от структуры данных, поэтому снимки собираются
  // руками: гонять ради каждого паттерна фикстуру через сплиттер значило бы
  // проверять не детектор, а разбор потока (это уже сделано в 2j и 2k).
  // Исключение — два последних теста: там берётся настоящий снимок фикстуры.
  const BASE_NOW = 2_000_000;

  // Здоровая идущая задача: ни один паттерн на ней срабатывать не должен.
  // Все ключи ProgressSnapshot на месте, чтобы подмена поля в тесте была видна
  // как изменение одной строки, а не как отсутствие остальных.
  const snap = (over = {}) => ({
    streaming: true,
    sessionId: "00000000-0000-4000-8000-0000000000aa",
    model: "claude-opus-5",
    startedAt: BASE_NOW - 60_000,
    finishedAt: null,
    elapsedMs: 60_000,
    lastActivityAt: BASE_NOW,
    idleSeconds: 0,
    segments: 1,
    resultEvents: 0,
    assistantEvents: 4,
    assistantTextBlocks: 1,
    toolCalls: 2,
    toolResults: 2,
    toolErrors: 0,
    openToolCalls: 0,
    toolsUsed: { Read: 2 },
    lastToolCall: null,
    lastAssistantText: "Читаю файлы проекта.",
    thinkingBlocks: 1,
    thinkingTokenEvents: 3,
    estimatedThinkingTokens: 120,
    cacheReadInputTokens: 10_000,
    cacheCreationInputTokens: 1_000,
    // Настоящее значение из фикстур: обычная работа, не лимит.
    rateLimit: { status: "allowed", utilization: 0.12, resetsAt: 1789258200 },
    recentEvents: [],
    repeatedCalls: {},
    lastResultCostUsd: null,
    badLines: 0,
    oversizeLines: 0,
    unknownTypes: {},
    ...over,
  });

  const toolCall = (over = {}) => ({
    name: "Bash",
    summary: "npm test",
    toolUseId: "toolu_0001",
    requestId: "aaaabbbbcccc",
    at: BASE_NOW - 240_000,
    completed: false,
    isError: null,
    repeat: 1,
    ...over,
  });

  const req = (over = {}) => ({
    requestId: "aaaabbbbcccc",
    toolName: "Bash",
    summary: "echo hook-stream-test",
    decision: "pending",
    deniedCount: 1,
    allowedCount: 0,
    firstSeenAt: BASE_NOW - 30_000,
    lastSeenAt: BASE_NOW - 1_000,
    resolvedAt: null,
    resolvedReason: null,
    ...over,
  });

  const dx = (over = {}) =>
    diagnose({
      tool: "execute_task",
      processId: "11111111-2222-3333-4444-555555555555",
      now: BASE_NOW,
      snapshot: snap(),
      permissions: [],
      streamEnabled: true,
      ...over,
    });

  // 1. По одному тесту на каждый из десяти паттернов.
  check("здоровая идущая задача не даёт паттернов", dx().pattern === null, JSON.stringify(dx()));

  const exhausted = dx({ permissions: [req({ decision: "exhausted", deniedCount: 11 })] });
  check(
    "исчерпанный бюджет повторов даёт permission_exhausted",
    exhausted.pattern === "permission_exhausted" &&
      exhausted.details.request_id === "aaaabbbbcccc" &&
      exhausted.details.denied_count === 11,
    JSON.stringify(exhausted.details),
  );

  const retryLoop = dx({ permissions: [req({ deniedCount: 3 })] });
  check(
    "три отказа по одному запросу дают permission_retry_loop",
    retryLoop.pattern === "permission_retry_loop" && retryLoop.details.denied_count === 3,
    JSON.stringify(retryLoop.details),
  );

  const flooding = dx({
    permissions: Array.from({ length: 6 }, (_, i) =>
      req({ requestId: `req${i}00000000`, firstSeenAt: BASE_NOW - 30_000 + i }),
    ),
  });
  check(
    "шесть одновременных запросов дают permission_flooding",
    flooding.pattern === "permission_flooding" &&
      flooding.details.pending_count === 6 &&
      flooding.details.request_id === "req000000000",
    JSON.stringify(flooding.details),
  );

  const onePending = dx({ permissions: [req()] });
  check(
    "один запрос даёт pending_permission",
    onePending.pattern === "pending_permission" &&
      onePending.details.pending_count === 1 &&
      onePending.details.age_seconds === 30,
    JSON.stringify(onePending.details),
  );

  const noProgress = dx({
    snapshot: snap({
      streaming: false,
      lastActivityAt: null,
      idleSeconds: null,
      elapsedMs: 90_000,
      assistantEvents: 0,
      assistantTextBlocks: 0,
      toolCalls: 0,
      toolResults: 0,
      toolsUsed: {},
      thinkingTokenEvents: 0,
      rateLimit: null,
    }),
  });
  check(
    "минута без единой строки потока даёт no_progress",
    noProgress.pattern === "no_progress" && noProgress.details.elapsed_ms === 90_000,
    JSON.stringify(noProgress.details),
  );

  const repeated = dx({
    snapshot: snap({
      repeatedCalls: { ddddeeeeffff: 4, aaaabbbbcccc: 1 },
      lastToolCall: toolCall({ requestId: "ddddeeeeffff", completed: true, isError: true, repeat: 4 }),
      toolCalls: 6,
    }),
  });
  check(
    "четыре одинаковых вызова дают repeated_tool_call",
    repeated.pattern === "repeated_tool_call" &&
      repeated.details.request_id === "ddddeeeeffff" &&
      repeated.details.count === 4 &&
      repeated.details.tool_name === "Bash" &&
      repeated.details.summary === "npm test",
    JSON.stringify(repeated.details),
  );

  const rateLimited = dx({
    snapshot: snap({ rateLimit: { status: "allowed", utilization: 0.97, resetsAt: 1789258200 } }),
  });
  check(
    "утилизация 97% даёт rate_limited даже при статусе allowed",
    rateLimited.pattern === "rate_limited" && rateLimited.details.utilization === 0.97,
    JSON.stringify(rateLimited.details),
  );
  const rateRejected = dx({
    snapshot: snap({ rateLimit: { status: "rejected", utilization: 0.2, resetsAt: null } }),
  });
  check(
    "статус не allowed даёт rate_limited при любой утилизации",
    rateRejected.pattern === "rate_limited" && rateRejected.details.status === "rejected",
    JSON.stringify(rateRejected.details),
  );

  const stalledSnapshot = snap({ idleSeconds: 200, elapsedMs: 260_000, openToolCalls: 0 });
  const stalled = dx({ snapshot: stalledSnapshot });
  check(
    "простой 200 с без незакрытых вызовов даёт stalled",
    stalled.pattern === "stalled" && stalled.details.idle_seconds === 200,
    JSON.stringify(stalled.details),
  );

  const thinkingOnly = dx({
    snapshot: snap({
      elapsedMs: 360_000,
      toolCalls: 0,
      toolResults: 0,
      toolsUsed: {},
      assistantTextBlocks: 0,
      thinkingTokenEvents: 42,
      estimatedThinkingTokens: 9_000,
    }),
  });
  check(
    "шесть минут размышления без действий дают thinking_only",
    thinkingOnly.pattern === "thinking_only" && thinkingOnly.details.thinking_token_events === 42,
    JSON.stringify(thinkingOnly.details),
  );

  // 2. Тот же простой, но инструмент физически выполняется, — это не зависание.
  //    Ради этого различия детектор и смотрит на openToolCalls.
  const toolRunning = dx({
    snapshot: snap({
      idleSeconds: 200,
      elapsedMs: 260_000,
      openToolCalls: 1,
      lastToolCall: toolCall({ at: BASE_NOW - 240_000, completed: false }),
    }),
  });
  check(
    "простой 200 с при незакрытом вызове даёт tool_running, а не stalled",
    toolRunning.pattern === "tool_running" &&
      toolRunning.details.tool_name === "Bash" &&
      toolRunning.details.summary === "npm test" &&
      toolRunning.details.running_seconds === 240,
    JSON.stringify(toolRunning.details),
  );
  check(
    "stalled и tool_running не срабатывают одновременно",
    stalled.patterns.length === 1 && toolRunning.patterns.length === 1,
    `${JSON.stringify(stalled.patterns.map((p) => p.code))} / ${JSON.stringify(
      toolRunning.patterns.map((p) => p.code),
    )}`,
  );
  check(
    "имя закрытого вызова в tool_running не выдумывается",
    dx({
      snapshot: snap({
        idleSeconds: 200,
        elapsedMs: 260_000,
        openToolCalls: 1,
        lastToolCall: toolCall({ completed: true, isError: false }),
      }),
    }).details.tool_name === null,
  );

  // 3. Буферный режим: пустой снимок там норма, а не зависание.
  check(
    "при streamEnabled false пустой снимок не считается зависанием",
    dx({
      snapshot: snap({
        streaming: false,
        lastActivityAt: null,
        idleSeconds: null,
        elapsedMs: 90_000,
        rateLimit: null,
      }),
      streamEnabled: false,
    }).pattern === null,
  );

  // 4. В plan_task размышление без действий — это и есть работа.
  check(
    "thinking_only не выдаётся для plan_task",
    dx({
      tool: "plan_task",
      snapshot: snap({
        elapsedMs: 360_000,
        toolCalls: 0,
        toolResults: 0,
        toolsUsed: {},
        assistantTextBlocks: 0,
        thinkingTokenEvents: 42,
      }),
    }).pattern === null,
  );

  // 5. Обычная утилизация лимита паттерном не является (в базовом снимке 0.12).
  check("утилизация 12% паттерном не является", dx().patterns.length === 0);

  // 6. Завершённая задача не диагностируется: у неё есть настоящий отчёт.
  check(
    "замороженный снимок не даёт паттернов",
    dx({
      snapshot: snap({ finishedAt: BASE_NOW, idleSeconds: 999, repeatedCalls: { ddddeeeeffff: 9 } }),
      permissions: [req(), req({ requestId: "ffff00001111", decision: "exhausted" })],
    }).patterns.length === 0,
  );

  // 7. Приоритет: когда подходит несколько паттернов, главный всегда один и тот же.
  const pendingOverStalled = dx({
    snapshot: stalledSnapshot,
    permissions: [req()],
  });
  check(
    "ожидание разрешения важнее простоя",
    pendingOverStalled.pattern === "pending_permission" &&
      pendingOverStalled.patterns.map((p) => p.code).join(",") === "pending_permission,stalled",
    JSON.stringify(pendingOverStalled.patterns.map((p) => p.code)),
  );

  const worstPermission = dx({
    permissions: [
      req({ requestId: "aaaabbbbcccc", decision: "exhausted", deniedCount: 11 }),
      req({ requestId: "bbbbccccdddd", deniedCount: 4 }),
      ...Array.from({ length: 5 }, (_, i) => req({ requestId: `req${i}00000000` })),
    ],
  });
  check(
    "исчерпанный бюджет важнее цикла повторов и наплыва запросов",
    worstPermission.pattern === "permission_exhausted" &&
      worstPermission.patterns.map((p) => p.code).join(",") ===
        "permission_exhausted,permission_retry_loop,permission_flooding",
    JSON.stringify(worstPermission.patterns.map((p) => p.code)),
  );
  check(
    "pending_permission не дублирует более специфичные паттерны",
    worstPermission.patterns.every((p) => p.code !== "pending_permission") &&
      flooding.patterns.every((p) => p.code !== "pending_permission"),
  );

  const circleOverStalled = dx({
    snapshot: snap({
      idleSeconds: 200,
      elapsedMs: 260_000,
      repeatedCalls: { ddddeeeeffff: 5 },
      lastToolCall: toolCall({ requestId: "ddddeeeeffff", completed: true, isError: true }),
    }),
  });
  check(
    "хождение по кругу важнее простоя",
    circleOverStalled.pattern === "repeated_tool_call" &&
      circleOverStalled.patterns.map((p) => p.code).join(",") === "repeated_tool_call,stalled",
    JSON.stringify(circleOverStalled.patterns.map((p) => p.code)),
  );

  const limitOverStalled = dx({
    snapshot: snap({
      idleSeconds: 200,
      elapsedMs: 260_000,
      rateLimit: { status: "allowed_warning", utilization: 0.99, resetsAt: 1789258200 },
    }),
  });
  check(
    "лимит важнее простоя: он его и объясняет",
    limitOverStalled.pattern === "rate_limited" &&
      limitOverStalled.patterns.map((p) => p.code).join(",") === "rate_limited,stalled",
    JSON.stringify(limitOverStalled.patterns.map((p) => p.code)),
  );
  check(
    "список паттернов отсортирован по убыванию важности",
    worstPermission.patterns.every(
      (p, i) => i === 0 || worstPermission.patterns[i - 1].severity >= p.severity,
    ) && worstPermission.severity === worstPermission.patterns[0].severity,
    JSON.stringify(worstPermission.patterns.map((p) => `${p.code}=${p.severity}`)),
  );

  // 8. Чистота: вход не меняется, повторный вызов даёт тот же результат.
  {
    const snapshot = snap({ idleSeconds: 200, elapsedMs: 260_000, repeatedCalls: { abcabcabcabc: 4 } });
    const permissions = [req(), req({ requestId: "bbbbccccdddd", deniedCount: 5 })];
    const before = JSON.stringify([snapshot, permissions]);
    const first = dx({ snapshot, permissions });
    const second = dx({ snapshot, permissions });
    check("детектор не меняет входные данные", JSON.stringify([snapshot, permissions]) === before);
    check(
      "повторный вызов даёт побайтово тот же диагноз",
      JSON.stringify(first) === JSON.stringify(second),
    );
    check(
      "detectPatterns и diagnose согласованы",
      JSON.stringify(detectPatterns({
        tool: "execute_task",
        processId: "11111111-2222-3333-4444-555555555555",
        now: BASE_NOW,
        snapshot,
        permissions,
        streamEnabled: true,
      })) === JSON.stringify(first.patterns) && first.pattern === first.patterns[0].code,
    );
  }

  // 9. Настоящий снимок фикстуры: в stream-denied-retry модель трижды повторяет
  //    один и тот же отклонённый Bash. Ничего синтетического в этом тесте нет.
  const retryRun = replayProgress("stream-denied-retry.ndjson");
  const retrySnapshot = retryRun.snapshot;
  const retryNow = retrySnapshot.lastActivityAt;
  const topRepeat = Object.entries(retrySnapshot.repeatedCalls).sort((a, b) => b[1] - a[1])[0];
  const realDiagnosis = diagnose({
    tool: "execute_task",
    processId: retrySnapshot.sessionId,
    now: retryNow,
    snapshot: retrySnapshot,
    permissions: [],
    streamEnabled: true,
  });
  check(
    "на реальном потоке сработал repeated_tool_call по самому частому вызову",
    realDiagnosis.pattern === "repeated_tool_call" &&
      realDiagnosis.details.request_id === topRepeat[0] &&
      realDiagnosis.details.count === topRepeat[1] &&
      retrySnapshot.repeatedCalls["b898d1f105d4"] === 3,
    `${JSON.stringify(realDiagnosis.details)}; повторы: ${JSON.stringify(retrySnapshot.repeatedCalls)}`,
  );

  // 10. Тот же настоящий снимок плюс запрос, по которому бюджет уже исчерпан:
  //     приоритет проверяется не только на синтетике.
  const realWithExhausted = diagnose({
    tool: "execute_task",
    processId: retrySnapshot.sessionId,
    now: retryNow,
    snapshot: retrySnapshot,
    permissions: [
      req({
        requestId: "b898d1f105d4",
        decision: "exhausted",
        deniedCount: 3,
        firstSeenAt: retryNow - 90_000,
      }),
    ],
    streamEnabled: true,
  });
  check(
    "на реальном снимке исчерпанный запрос вытесняет repeated_tool_call",
    realWithExhausted.pattern === "permission_exhausted" &&
      realWithExhausted.details.request_id === "b898d1f105d4" &&
      realWithExhausted.patterns.map((p) => p.code).join(",") ===
        "permission_exhausted,repeated_tool_call",
    JSON.stringify(realWithExhausted.patterns.map((p) => p.code)),
  );
  check(
    "фраза паттерна называет операцию и не тащит содержимое результатов",
    realWithExhausted.message.includes("b898d1f105d4") &&
      realWithExhausted.message.includes("echo hook-stream-test") &&
      !realWithExhausted.message.includes("НЕ ИЩИ ОБХОДНОЙ ПУТЬ"),
    realWithExhausted.message,
  );

  console.log("\n2o. ProgressView: живое состояние в форме отчёта");

  // Трансформация и подсказка вынесены в отдельный модуль ровно ради этой
  // секции: dist/index.js импортировать нельзя, он стартует сервер на импорте.
  // Снимок берём настоящий — тот же retrySnapshot, что и в 2m.
  {
    const view = toProgressView(retrySnapshot);
    const exp = progressExpectations[0];

    check(
      "view доносит счётчики снимка без потерь",
      view.tool_calls === exp.toolCalls &&
        view.tool_results === exp.toolResults &&
        view.tool_errors === exp.toolErrors &&
        view.assistant_events === exp.assistantEvents &&
        view.assistant_text_blocks === exp.assistantTextBlocks &&
        sortedCounts(view.tools_used) === exp.toolsUsed &&
        view.last_result_cost_usd === exp.cost,
      `${view.tool_calls}/${view.assistant_events}; ${sortedCounts(view.tools_used)}`,
    );
    check(
      "последний вызов назван вместе с request_id, который одобряет оператор",
      view.last_tool_call !== null &&
        view.last_tool_call.request_id === retrySnapshot.lastToolCall.requestId &&
        view.last_tool_call.is_error === exp.lastIsError &&
        view.last_tool_call.completed === true,
      JSON.stringify(view.last_tool_call),
    );

    // Форма отчёта не должна «мигать» между режимами: пустой прогресс (поток
    // выключен или CLI не дал ни строки) обязан дать те же ключи.
    const emptyView = toProgressView(new JobProgress(1_000_000, () => 1_000_000).snapshot());
    const keys = (o) => Object.keys(o).sort().join(",");
    check(
      "набор ключей не зависит от наполненности",
      keys(view) === keys(emptyView),
      `${keys(view)}\n       ${keys(emptyView)}`,
    );
    check(
      "пустой прогресс — это нули и null, а не отсутствующие поля",
      emptyView.streaming === false &&
        emptyView.tool_calls === 0 &&
        emptyView.idle_seconds === null &&
        emptyView.last_tool_call === null &&
        emptyView.rate_limit === null &&
        emptyView.last_result_cost_usd === null &&
        JSON.stringify(emptyView.tools_used) === "{}" &&
        emptyView.recent_events.length === 0,
      JSON.stringify(emptyView),
    );

    // Время — ISO, как в permission_requests: отчёт не смешивает форматы.
    const isIso = (s) => typeof s === "string" && s.endsWith("Z") && !Number.isNaN(Date.parse(s));
    check(
      "время переведено в ISO",
      isIso(view.last_activity_at) &&
        isIso(view.last_tool_call.at) &&
        view.recent_events.length > 0 &&
        view.recent_events.every((e) => isIso(e.at)),
      `${view.last_activity_at}; ${view.last_tool_call.at}`,
    );
    // resetsAt приходит в unix-секундах, и умножение на 1000 здесь единственное.
    const rated = toProgressView(snap());
    check(
      "resets_at развёрнут из unix-секунд",
      rated.rate_limit.resets_at === new Date(1789258200 * 1000).toISOString(),
      rated.rate_limit.resets_at,
    );

    // Заморозка: у завершённой задачи elapsed_ms не растёт вместе с часами,
    // иначе отчёт по вчерашней задаче заявлял бы часы работы.
    let clock = 5_000;
    const frozen = new JobProgress(0, () => clock);
    frozen.freeze(4_000);
    const firstView = toProgressView(frozen.snapshot());
    clock = 900_000;
    const laterView = toProgressView(frozen.snapshot());
    check(
      "elapsed_ms замороженной задачи не растёт",
      firstView.elapsed_ms === 4_000 && laterView.elapsed_ms === 4_000,
      `${firstView.elapsed_ms} → ${laterView.elapsed_ms}`,
    );

    // Сводка для лога: счётчики и имена есть, текстов нет ни одного.
    const fields = progressLogFields(retrySnapshot);
    check(
      "сводка для лога несёт счётчики и session_id",
      fields.stream_tool_calls === exp.toolCalls &&
        fields.stream_session_id === exp.sessionId &&
        sortedCounts(fields.stream_tools_used) === exp.toolsUsed,
      JSON.stringify(fields),
    );
    const loggedText = JSON.stringify(fields);
    check(
      "в сводку не попадают ни текст модели, ни выжимки вызовов, ни лента событий",
      !loggedText.includes(retrySnapshot.lastAssistantText.slice(0, 30)) &&
        !loggedText.includes(retrySnapshot.lastToolCall.summary) &&
        !loggedText.includes("recent_events") &&
        !loggedText.includes("НЕ ИЩИ ОБХОДНОЙ ПУТЬ"),
      loggedText,
    );

    // Подсказка остановленной задачи: то, ради чего затевался частичный
    // результат. Сегодня на её месте было «JSON-отчёт не сформирован».
    const canceledHint = buildTerminalHint({
      status: "canceled",
      snapshot: retrySnapshot,
      hasResultText: false,
      sessionId: retrySnapshot.sessionId,
    });
    check(
      "подсказка отменённой задачи перечисляет, что успело произойти",
      canceledHint.includes(`вызовов инструментов ${exp.toolCalls}`) &&
        canceledHint.includes("Bash×5") &&
        canceledHint.includes(retrySnapshot.lastToolCall.name) &&
        canceledHint.includes("session_id сохранён") &&
        !canceledHint.includes("НЕ ИЩИ ОБХОДНОЙ ПУТЬ"),
      canceledHint,
    );
    check(
      "подсказка таймаута названа таймаутом",
      buildTerminalHint({
        status: "timeout",
        snapshot: retrySnapshot,
        hasResultText: false,
        sessionId: null,
      }).startsWith("Задача прервана по таймауту"),
    );
    check(
      "без session_id подсказка не обещает продолжения",
      buildTerminalHint({
        status: "canceled",
        snapshot: retrySnapshot,
        hasResultText: false,
        sessionId: null,
      }).includes("продолжить именно эту сессию не выйдет"),
    );
    check(
      "при готовом отчёте подсказка отправляет к result_text, а не к счётчикам",
      (() => {
        const h = buildTerminalHint({
          status: "canceled",
          snapshot: retrySnapshot,
          hasResultText: true,
          sessionId: retrySnapshot.sessionId,
        });
        return h.includes("result_text") && !h.includes("Итогового отчёта CLI нет");
      })(),
    );
    check(
      "при пустом прогрессе подсказка честно говорит, что судить нечем",
      buildTerminalHint({
        status: "canceled",
        snapshot: new JobProgress(0, () => 1_000).snapshot(),
        hasResultText: false,
        sessionId: null,
      }).includes("streamEvents: false"),
    );
  }

  // Здоровая быстрая задача паттернов не даёт — значит next_step у неё остаётся
  // сегодняшней общей фразой, и регресса для коротких прогонов нет.
  check("на здоровом снимке diagnose молчит и подсказку не подменяет", dx().message === null);

  console.log("\n3. get_task_status с неизвестным id");
  const unknown = await client.callTool({
    name: "get_task_status",
    arguments: { process_id: "00000000-0000-0000-0000-000000000000" },
  });
  check("неизвестный process_id даёт понятную ошибку", unknown.isError === true);

  console.log("\n4. Протокол: отказы без обращения к Claude Code");

  const noSession = await client.callTool({
    name: "execute_task",
    arguments: { task_text: "сделай что-нибудь", project_dir: projectDir },
  });
  check("execute_task без session_id отклонён", noSession.isError === true);

  const unknownSession = await client.callTool({
    name: "execute_task",
    arguments: {
      task_text: "сделай что-нибудь",
      project_dir: projectDir,
      session_id: "00000000-0000-0000-0000-000000000000",
    },
  });
  check("execute_task с неизвестной сессией отклонён", unknownSession.isError === true);

  const approveUnknown = await client.callTool({
    name: "approve_plan",
    arguments: { session_id: "00000000-0000-0000-0000-000000000000", plan_digest: "deadbeef1234" },
  });
  check("approve_plan для неизвестной сессии отклонён", approveUnknown.isError === true);

  // Так выглядел вызов через прокси, терявший session_id: SDK отбивает его
  // до хендлера, и раньше в логе не оставалось ничего.
  const approveNoSession = await client
    .callTool({ name: "approve_plan", arguments: { plan_digest: "deadbeef1234" } })
    .catch((err) => ({ isError: true, thrown: String(err) }));
  check("approve_plan без session_id отклонён", approveNoSession.isError === true);
  const invalidArgsLog = readFileSync(join(workspace, "logs", "ccc-mcp.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((l) => l.event === "invalid_args" && l.tool === "approve_plan");
  check(
    "невалидные аргументы попали в лог как invalid_args с ключами, но без значений",
    invalidArgsLog !== undefined &&
      invalidArgsLog.received?.plan_digest === "string" &&
      !("session_id" in invalidArgsLog.received) &&
      !JSON.stringify(invalidArgsLog).includes("deadbeef1234"),
    JSON.stringify(invalidArgsLog),
  );

  // Синоним session: обход прокси remote-devices, теряющего ключ session_id.
  // С одним session вызов обязан пройти схему и дойти до хендлера — тогда
  // отказ приходит от реестра сессий («неизвестна мосту»), а не -32602.
  const smokeLog = () =>
    readFileSync(join(workspace, "logs", "ccc-mcp.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  for (const name of ["plan_task", "approve_plan", "execute_task"]) {
    const props = tools.find((t) => t.name === name)?.inputSchema?.properties ?? {};
    check(
      `${name} объявляет и session_id, и синоним session`,
      Object.hasOwn(props, "session_id") && Object.hasOwn(props, "session"),
      `свойства: ${Object.keys(props).join(", ")}`,
    );
  }
  const approveAlias = await client.callTool({
    name: "approve_plan",
    arguments: { session: "00000000-0000-0000-0000-00000000a11a", plan_digest: "deadbeef1234" },
  });
  check(
    "approve_plan с одним session доходит до хендлера",
    approveAlias.isError === true &&
      /неизвестна мосту/.test(errText(approveAlias)) &&
      !/-32602/.test(errText(approveAlias)),
    errText(approveAlias),
  );
  check(
    "отказ по синониму залогирован с session_param: session",
    smokeLog().some(
      (l) =>
        l.event === "denied" &&
        l.tool === "approve_plan" &&
        l.session_id === "00000000-0000-0000-0000-00000000a11a" &&
        l.session_param === "session",
    ),
  );
  const executeAlias = await client.callTool({
    name: "execute_task",
    arguments: {
      task_text: "сделай что-нибудь",
      project_dir: projectDir,
      session: "00000000-0000-0000-0000-00000000a11a",
    },
  });
  check(
    "execute_task с одним session доходит до хендлера",
    executeAlias.isError === true &&
      /неизвестна|не проходила/.test(errText(executeAlias)) &&
      !/-32602/.test(errText(executeAlias)),
    errText(executeAlias),
  );
  const approveConflict = await client.callTool({
    name: "approve_plan",
    arguments: {
      session_id: "00000000-0000-0000-0000-000000000001",
      session: "00000000-0000-0000-0000-000000000002",
      plan_digest: "deadbeef1234",
    },
  });
  check(
    "расходящиеся session_id и session отклонены схемой",
    approveConflict.isError === true &&
      /-32602/.test(errText(approveConflict)) &&
      /разными значениями/.test(errText(approveConflict)),
    errText(approveConflict),
  );
  const approveBothSame = await client.callTool({
    name: "approve_plan",
    arguments: {
      session_id: "00000000-0000-0000-0000-000000000003",
      session: "00000000-0000-0000-0000-000000000003",
      plan_digest: "deadbeef1234",
    },
  });
  check(
    "совпадающие session_id и session принимаются",
    approveBothSame.isError === true && /неизвестна мосту/.test(errText(approveBothSame)),
    errText(approveBothSame),
  );
  const approveNeither = errText(approveNoSession) + (approveNoSession.thrown ?? "");
  check(
    "без обоих имён отказ называет синоним",
    /session_id/.test(approveNeither) && /синоним session/.test(approveNeither),
    approveNeither,
  );

  console.log("\n5. Открытые вопросы: распознавание и блокировка одобрения");

  const planWithQuestions = [
    "## План",
    "Добавить отправку уведомлений.",
    "",
    "## Открытые вопросы",
    "1. Какой канал — email или push?",
  ].join("\n");

  check("раздел распознан", detectOpenQuestions(planWithQuestions) === true);
  check(
    "жирный заголовок распознан",
    detectOpenQuestions("**Открытые вопросы**\n- что-то") === true,
  );
  check("английский вариант распознан", detectOpenQuestions("### Open questions\n- a") === true);
  check("чистый план не даёт срабатывания", detectOpenQuestions("## План\nЗаменить hi на hello.") === false);
  check(
    "упоминание в тексте не считается заголовком",
    detectOpenQuestions("Я вынес всё в раздел Открытые вопросы ниже по тексту.") === false,
  );

  // План с вопросами не должен попадать в состояние, пригодное для одобрения.
  const registry = new SessionRegistry(60_000);
  const blockedRecord = registry.recordPlanned("s-blocked", projectDir, planWithQuestions, true);
  check(
    "сессия ушла в needs_clarification",
    blockedRecord.state === "needs_clarification",
    `получено: ${blockedRecord.state}`,
  );

  let approveRejected = false;
  let approveMessage = "";
  try {
    registry.approve("s-blocked", blockedRecord.planDigest);
  } catch (err) {
    approveRejected = true;
    approveMessage = err.message;
  }
  check("approve_plan для такой сессии отклонён", approveRejected === true);
  check(
    "в причине названы открытые вопросы",
    /Открытые вопросы/.test(approveMessage),
    approveMessage,
  );

  let executeRejected = false;
  try {
    registry.beginExecution("s-blocked", projectDir);
  } catch {
    executeRejected = true;
  }
  check("execute_task для такой сессии отклонён", executeRejected === true);

  const cleanRecord = registry.recordPlanned("s-clean", projectDir, "## План\nВсё ясно.", false);
  check("чистый план сразу planned", cleanRecord.state === "planned", `получено: ${cleanRecord.state}`);
  check(
    "подсказка плана объясняет, что ExitPlanMode нет и искать его не нужно",
    /ExitPlanMode/.test(PLAN_SYSTEM_PROMPT) && /ToolSearch/.test(PLAN_SYSTEM_PROMPT),
  );
  check("в подсказке выполнения про ExitPlanMode ничего нет", !/ExitPlanMode/.test(EXECUTE_SYSTEM_PROMPT));
  check(
    "подсказка плана объясняет границу: менять ничего нельзя, «выполни» превращать в план",
    /этап разведки и плана/.test(PLAN_SYSTEM_PROMPT) &&
      /даже если настройки разрешений их пропустили бы/.test(PLAN_SYSTEM_PROMPT) &&
      /построй план этой работы и не выполняй её/.test(PLAN_SYSTEM_PROMPT),
  );
  check("в подсказке выполнения границы планирования нет", !/этап разведки и плана/.test(EXECUTE_SYSTEM_PROMPT));

  console.log("\n5b. Одна сессия — одна идущая задача (поддельный claude)");
  if (process.platform === "win32") {
    // fake-claude.mjs запускается через shebang, а мост без shell .mjs на Windows не стартует.
    console.log("  пропущено: поддельный claude не запускается на Windows");
  } else {
    const fakeConfig = join(workspace, "ccc-mcp.fake.config.json");
    writeFileSync(
      fakeConfig,
      JSON.stringify({
        allowedRoots: [workspace],
        claudeBin: join(root, "scripts", "fixtures", "fake-claude.mjs"),
        timeoutMs: 300000,
        defaultWaitSeconds: 0,
        // Сценарий держит до пяти идущих задач разом; предел здесь не предмет проверки.
        maxConcurrent: 10,
        // Хуки включены ради проверки get_bridge_info; поддельный claude их не вызывает.
        hooksEnabled: true,
        operatorAbsentMinutes: 7,
        autoApproveCommands: ["npm run build 2>&1 | tail -20"],
        logFile: join(workspace, "logs", "fake.jsonl"),
      }),
    );
    const fakeClient = new Client({ name: "ccc-mcp-smoke-fake", version: "1.0.0" });
    await fakeClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "dist", "index.js")],
        env: { ...serverEnv, CCC_MCP_CONFIG: fakeConfig },
        stderr: "inherit",
      }),
    );
    const fcall = (name, args) => fakeClient.callTool({ name, arguments: args });
    const frep = (r) => JSON.parse(r.content[0].text);
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const busy = (r, processId) =>
      r.isError === true &&
      errText(r).includes(processId) &&
      /get_task_status/.test(errText(r)) &&
      /cancel_task/.test(errText(r));
    const stopJob = async (processId) => {
      await fcall("cancel_task", { process_id: processId });
      for (let i = 0; i < 50; i++) {
        const st = frep(await fcall("get_task_status", { process_id: processId }));
        if (st.status !== "running") return st.status;
        await pause(100);
      }
      return "running";
    };

    try {
      const finfo = frep(await fcall("get_bridge_info", {}));
      check(
        "get_bridge_info при включённых хуках отдаёт настройки разрешений и списки дословно",
        finfo.permissions.hooks_enabled === true &&
          finfo.permissions.operator_absent_minutes === 7 &&
          finfo.permissions.auto_approve_commands?.[0] === "npm run build 2>&1 | tail -20" &&
          finfo.permissions.plan_hooked_tools?.join(",") === "Bash,Monitor" &&
          finfo.permissions.plan_auto_approve_read_only === true &&
          /7 мин/.test(finfo.next_step),
        JSON.stringify(finfo.permissions),
      );

      // Новая сессия: её id известен только из строки init потока.
      const a = frep(await fcall("plan_task", { task_text: "долгая", project_dir: projectDir }));
      let sidA = null;
      for (let i = 0; i < 50 && !sidA; i++) {
        sidA = frep(await fcall("get_task_status", { process_id: a.process_id })).session_id;
        if (!sidA) await pause(100);
      }
      check("задача идёт, session_id пришёл из init", a.status === "running" && !!sidA, String(sidA));

      // list_tasks: потерянный process_id находится без чтения лога.
      const listed = frep(await fcall("list_tasks", { status: "running" }));
      const listedA = listed.tasks.find((t) => t.process_id === a.process_id);
      check(
        "list_tasks показывает идущую задачу с process_id, session_id и выжимкой",
        listedA?.status === "running" &&
          listedA.tool === "plan_task" &&
          listedA.session_id === sidA &&
          listedA.task_preview === "долгая" &&
          typeof listed.server_started_at === "string" &&
          /get_task_status/.test(listed.next_step),
        JSON.stringify(listed),
      );
      const otherDir = frep(
        await fcall("list_tasks", { project_dir: workspace, status: "running" }),
      );
      check(
        "list_tasks фильтрует по project_dir",
        otherDir.count === 0 && otherDir.total_matching === 0,
        JSON.stringify(otherDir),
      );
      const outsideDir = await fcall("list_tasks", { project_dir: "/etc" });
      check("list_tasks отклоняет каталог вне белого списка", outsideDir.isError === true);

      const resumeA = await fcall("plan_task", { task_text: "x", project_dir: projectDir, session_id: sidA });
      check(
        "продолжение сессии, созданной идущей задачей, отклонено с её process_id",
        busy(resumeA, a.process_id),
        errText(resumeA),
      );
      const resumeAlias = await fcall("plan_task", { task_text: "x", project_dir: projectDir, session: sidA });
      check("то же через синоним session", busy(resumeAlias, a.process_id), errText(resumeAlias));

      // Продолжение по id, известному сразу (--resume).
      const X = "11111111-1111-4111-8111-111111111111";
      const d = frep(await fcall("plan_task", { task_text: "долгая", project_dir: projectDir, session_id: X }));
      const e = await fcall("plan_task", { task_text: "x", project_dir: projectDir, session_id: X });
      check("второй resume той же сессии отклонён", d.status === "running" && busy(e, d.process_id), errText(e));

      // Два вызова почти одновременно: бронь до первого await пропускает только один.
      const Y = "22222222-2222-4222-8222-222222222222";
      const pair = await Promise.all([
        fcall("plan_task", { task_text: "долгая", project_dir: projectDir, session_id: Y }),
        fcall("plan_task", { task_text: "долгая", project_dir: projectDir, session_id: Y }),
      ]);
      const started = pair.filter((r) => r.isError !== true);
      check(
        "из двух одновременных запусков одной сессии прошёл ровно один",
        started.length === 1 && pair.filter((r) => r.isError === true).length === 1,
        pair.map((r) => (r.isError ? errText(r) : "ok")).join(" | "),
      );

      // execute_task по одобренной сессии, пока её продолжает plan_task.
      const planned = frep(
        await fcall("plan_task", { task_text: "FINISH", project_dir: projectDir, wait_seconds: 10 }),
      );
      const Z = planned.session_id;
      await fcall("approve_plan", { session_id: Z, plan_digest: planned.plan_digest });
      const zPlan = frep(await fcall("plan_task", { task_text: "долгая", project_dir: projectDir, session_id: Z }));
      const zExec = await fcall("execute_task", { task_text: "x", project_dir: projectDir, session_id: Z });
      check("execute_task отклонён, пока сессию продолжает plan_task", busy(zExec, zPlan.process_id), errText(zExec));
      const log = readFileSync(join(workspace, "logs", "fake.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      check(
        "отказ по занятости залогирован как denied",
        log.some((l) => l.event === "denied" && l.tool === "execute_task" && l.session_id === Z),
      );

      // После остановки сессия свободна, а одобрение отказ не тронул.
      await stopJob(zPlan.process_id);
      const zExec2 = await fcall("execute_task", { task_text: "долгая", project_dir: projectDir, session_id: Z });
      check(
        "после остановки execute_task стартует по тому же одобрению",
        zExec2.isError !== true && frep(zExec2).status === "running",
        zExec2.isError ? errText(zExec2) : "",
      );
      await stopJob(frep(zExec2).process_id);

      await stopJob(a.process_id);
      const resumeAfter = await fcall("plan_task", { task_text: "долгая", project_dir: projectDir, session_id: sidA });
      check(
        "после остановки задачи сессию можно продолжить",
        resumeAfter.isError !== true && frep(resumeAfter).status === "running",
        resumeAfter.isError ? errText(resumeAfter) : "",
      );
      if (resumeAfter.isError !== true) await stopJob(frep(resumeAfter).process_id);
      await stopJob(d.process_id);
      for (const r of started) await stopJob(frep(r).process_id);

      const afterAll = frep(await fcall("list_tasks", {}));
      check(
        "после остановки list_tasks не видит идущих, но помнит завершённые, новые первыми",
        afterAll.tasks.every((t) => t.status !== "running") &&
          afterAll.tasks.some((t) => t.process_id === a.process_id && t.status === "canceled") &&
          afterAll.tasks.every(
            (t, i, arr) => i === 0 || arr[i - 1].started_at >= t.started_at,
          ),
        JSON.stringify(afterAll.tasks.map((t) => [t.status, t.started_at])),
      );
      const limited = frep(await fcall("list_tasks", { limit: 2 }));
      check(
        "limit ограничивает выдачу, total_matching — нет",
        limited.count === 2 && limited.total_matching > 2,
        JSON.stringify({ count: limited.count, total: limited.total_matching }),
      );
    } finally {
      await fakeClient.close();
    }
  }

  console.log("\nPATH дочернего claude из реестра (Windows)");
  {
    const src = { SystemRoot: "C:\\Windows", UserProfile: "C:\\Users\\u" };
    check(
      "%VAR% раскрывается без учёта регистра имени",
      expandWindowsVars("%SYSTEMROOT%\\system32;%userprofile%\\bin", src) ===
        "C:\\Windows\\system32;C:\\Users\\u\\bin",
    );
    check("неизвестная %VAR% остаётся как есть", expandWindowsVars("%NOPE%\\x", src) === "%NOPE%\\x");
    const joined = joinWindowsPath(["%SystemRoot%\\system32;C:\\A\\;;", "c:\\a;C:\\B"], src);
    check(
      "HKLM+HKCU склеиваются без пустых элементов и повторов",
      joined === "C:\\Windows\\system32;C:\\A\\;C:\\B",
      `получено: ${joined}`,
    );
    const dropped = diffWindowsPath("C:\\WindowsApps\\pwsh;C:\\A;c:\\b\\;C:\\Git\\mingw64\\bin", joined);
    check(
      "diff показывает только добавки родителя",
      JSON.stringify(dropped) === JSON.stringify(["C:\\WindowsApps\\pwsh", "C:\\Git\\mingw64\\bin"]),
      `получено: ${JSON.stringify(dropped)}`,
    );
    check("pathKey находит «Path» в Windows-регистре", pathKey({ Path: "x", HOME: "y" }) === "Path");
    check("pathKey без PATH даёт «PATH»", pathKey({ HOME: "y" }) === "PATH");

    const pwshDir = "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe";
    const kept = keepPwshPackageDir(`${pwshDir};C:\\Windows;C:\\Git\\mingw64\\bin`, "C:\\Windows;C:\\Git\\cmd");
    check(
      "каталог MSIX-пакета PowerShell ставится первым — иначе раньше него найдётся алиас",
      kept === `${pwshDir};C:\\Windows;C:\\Git\\cmd`,
      `получено: ${kept}`,
    );
    check(
      "прочие каталоги WindowsApps не переносятся",
      keepPwshPackageDir("C:\\Program Files\\WindowsApps\\Other.App_1.0\\;C:\\Windows", "C:\\Windows") ===
        "C:\\Windows",
    );
    check(
      "без пакета PowerShell собранный PATH не меняется",
      keepPwshPackageDir("C:\\Windows;C:\\Git\\cmd", "C:\\Windows") === "C:\\Windows",
    );
    check(
      "каталог, уже есть в собранном PATH, не дублируется",
      keepPwshPackageDir(`${pwshDir}\\`, `C:\\Windows;${pwshDir}`) === `C:\\Windows;${pwshDir}`,
    );
  }

  console.log("\nЗапрет вложенного моста");
  {
    const marked = markNested({ HOME: "y" });
    check("markNested ставит метку", marked[NESTED_ENV_VAR] === "1" && isNested(marked));
    check("без метки не вложен", isNested({ HOME: "y" }) === false);
    check("пустая метка не считается", isNested({ [NESTED_ENV_VAR]: "  " }) === false);
    check(
      "scrubEnv метку не вычищает — она доходит до внуков",
      scrubEnv({ [NESTED_ENV_VAR]: "1", CLAUDE_X: "z" }).env[NESTED_ENV_VAR] === "1",
    );
    const nested = spawnSync(process.execPath, [join(root, "dist", "index.js")], {
      env: { ...serverEnv, [NESTED_ENV_VAR]: "1" },
      encoding: "utf8",
      input: "",
      timeout: 15_000,
    });
    check(
      "сервер с меткой завершается сразу и с ненулевым кодом",
      nested.status !== 0 && nested.status !== null,
      `status=${nested.status} error=${nested.error?.code ?? ""}`,
    );
    check(
      "в stderr названа причина",
      (nested.stderr ?? "").includes(NESTED_ENV_VAR),
      (nested.stderr ?? "").slice(0, 200),
    );
  }

  if (!live) {
    console.log("\n(режим --no-live: реальные вызовы Claude Code пропущены)");
  } else {
    console.log("\n6. Асинхронный запуск plan_task (реальный вызов Claude Code)");

    const started = report(
      await client.callTool({
        name: "plan_task",
        arguments: {
          task_text: "Ответь ровно одним словом: PONG. Ничего не меняй в файлах.",
          project_dir: projectDir,
          // Алиас, а не полное имя: заодно проверяем, что model_used показывает
          // развёрнутое значение, а не эхо запроса.
          model: "sonnet",
          wait_seconds: 0,
        },
      }),
    );
    check("вернулся process_id", typeof started.process_id === "string" && started.process_id.length > 0);
    check("статус running", started.status === "running", `получено: ${started.status}`);
    check(
      "у running-задачи есть progress с полным набором ключей",
      started.progress !== null &&
        typeof started.progress === "object" &&
        typeof started.progress.elapsed_ms === "number" &&
        typeof started.progress.tool_calls === "number" &&
        typeof started.progress.tools_used === "object" &&
        Array.isArray(started.progress.recent_events),
      JSON.stringify(started.progress),
    );
    check(
      "причина возврата ожидания названа",
      started.wait_ended_reason === "timeout" || started.wait_ended_reason === "completed",
      `получено: ${started.wait_ended_reason}`,
    );

    console.log("\n7. Опрос get_task_status до завершения");
    let final = started;
    for (let i = 0; i < 12 && final.status === "running"; i++) {
      final = report(
        await client.callTool({
          name: "get_task_status",
          arguments: { process_id: started.process_id, wait_seconds: 30 },
        }),
      );
    }

    check("задача завершилась", final.status !== "running", `статус: ${final.status}`);
    check(
      "поток разобран без единой плохой строки",
      final.progress.streaming === true &&
        final.progress.bad_lines === 0 &&
        final.progress.oversize_lines === 0,
      JSON.stringify({
        streaming: final.progress.streaming,
        bad_lines: final.progress.bad_lines,
        oversize: final.progress.oversize_lines,
        unknown: final.progress.unknown_event_types,
      }),
    );
    // Заморозка на живой задаче: повторный опрос обязан вернуть то же время,
    // иначе отчёт по давно закончившейся задаче заявлял бы часы простоя.
    const polledAgain = report(
      await client.callTool({
        name: "get_task_status",
        arguments: { process_id: started.process_id },
      }),
    );
    check(
      "у завершённой задачи прогресс заморожен",
      final.progress.elapsed_ms > 0 &&
        polledAgain.progress.elapsed_ms === final.progress.elapsed_ms &&
        polledAgain.progress.idle_seconds === final.progress.idle_seconds,
      `${final.progress.elapsed_ms} → ${polledAgain.progress.elapsed_ms}`,
    );

    if (!final.ok) {
      console.log(`\n  Claude Code вернул ошибку: ${final.result_text ?? final.parse_error}`);
      if (final.hint) console.log(`  Подсказка: ${final.hint}`);
    }
    check("ok=true", final.ok === true, final.hint ?? "");
    check("вернулся session_id", typeof final.session_id === "string" && final.session_id.length > 0);
    check("есть текст результата", typeof final.result_text === "string" && final.result_text.length > 0);
    check("состояние сессии planned", final.session_state === "planned", `получено: ${final.session_state}`);
    check("выдан plan_digest", typeof final.plan_digest === "string" && final.plan_digest.length > 0);
    check(
      "model_requested — запрошенный алиас",
      final.model_requested === "sonnet",
      `получено: ${final.model_requested}`,
    );
    check(
      "model_used — развёрнутое имя модели",
      final.model_used === "claude-sonnet-5",
      `получено: ${final.model_used}`,
    );
    check(
      "чёткая задача не породила открытых вопросов",
      final.has_open_questions === false,
      `result_text: ${String(final.result_text).slice(0, 200)}`,
    );

    if (final.ok && final.session_id) {
      console.log("\n8. execute_task без approve_plan должен быть отклонён");
      const notApproved = await client.callTool({
        name: "execute_task",
        arguments: {
          task_text: "Создай файл hacked.txt.",
          project_dir: projectDir,
          session_id: final.session_id,
          wait_seconds: 60,
        },
      });
      check("выполнение без одобрения отклонено", notApproved.isError === true);
      check(
        "в отказе сказано про approve_plan",
        notApproved.isError === true && /approve_plan/.test(notApproved.content[0].text),
        notApproved.content[0].text,
      );

      console.log("\n9. approve_plan с неверным plan_digest");
      const badDigest = await client.callTool({
        name: "approve_plan",
        arguments: { session_id: final.session_id, plan_digest: "000000000000" },
      });
      check("неверный plan_digest отклонён", badDigest.isError === true);

      console.log("\n10. approve_plan с верным plan_digest, через синоним session");
      // Живой прогон одобряет через session, а выполняет через session_id:
      // так обе формы проходят полный цикл на реальной сессии.
      const approved = report(
        await client.callTool({
          name: "approve_plan",
          arguments: { session: final.session_id, plan_digest: final.plan_digest },
        }),
      );
      check("состояние стало approved", approved.session_state === "approved", `получено: ${approved.session_state}`);

      console.log("\n11. execute_task после одобрения, на другой модели");
      // План строился на sonnet, выполняем на opus: одобрение привязано к тексту
      // плана и каталогу, а не к модели, и --resume смену модели переживает.
      const executed = report(
        await client.callTool({
          name: "execute_task",
          arguments: {
            task_text: "Какое слово ты только что ответил? Ответь одним словом.",
            project_dir: projectDir,
            session_id: final.session_id,
            model: "opus",
            wait_seconds: 120,
          },
        }),
      );
      check("выполнение прошло", executed.ok === true, executed.hint ?? executed.status);
      check(
        "session_id сохранился",
        executed.session_id === final.session_id,
        `было ${final.session_id}, стало ${executed.session_id}`,
      );
      check(
        "контекст подхвачен",
        typeof executed.result_text === "string" && /pong/i.test(executed.result_text),
        `ответ: ${executed.result_text}`,
      );
      check("состояние стало executed", executed.session_state === "executed", `получено: ${executed.session_state}`);
      check(
        "смена модели на --resume отработала",
        executed.model_used === "claude-opus-5",
        `получено: ${executed.model_used}`,
      );

      console.log("\n12. Повторный execute_task по израсходованному одобрению");
      const again = await client.callTool({
        name: "execute_task",
        arguments: {
          task_text: "Ещё раз.",
          project_dir: projectDir,
          session_id: final.session_id,
          wait_seconds: 30,
        },
      });
      check("повторное выполнение отклонено", again.isError === true);
    }

    console.log("\n13. Заведомо неполная задача должна дать открытые вопросы");
    // Ключевой параметр не указан намеренно: не сказано, на что менять текст.
    // Правильное поведение — перечислить вопросы, а не выдумать значение и
    // не попытаться вызвать AskUserQuestion (инструмент запрещён).
    const vague = report(
      await client.callTool({
        name: "plan_task",
        arguments: {
          task_text:
            "Поменяй текст приветствия в файле README.md на новый. Сделай это аккуратно.",
          project_dir: projectDir,
          wait_seconds: 120,
        },
      }),
    );

    check("план получен", vague.ok === true, vague.hint ?? vague.status);
    if (vague.ok) {
      check(
        "has_open_questions = true",
        vague.has_open_questions === true,
        `result_text: ${String(vague.result_text).slice(0, 400)}`,
      );
      check(
        "сессия в needs_clarification",
        vague.session_state === "needs_clarification",
        `получено: ${vague.session_state}`,
      );
      check(
        "next_step ведёт к уточнению, а не к approve_plan",
        typeof vague.next_step === "string" && /уточните/i.test(vague.next_step),
        vague.next_step ?? "(пусто)",
      );

      const approveVague = await client.callTool({
        name: "approve_plan",
        arguments: { session_id: vague.session_id, plan_digest: vague.plan_digest },
      });
      check("approve_plan отклонён для плана с вопросами", approveVague.isError === true);

      const executeVague = await client.callTool({
        name: "execute_task",
        arguments: {
          task_text: "Выполняй",
          project_dir: projectDir,
          session_id: vague.session_id,
          wait_seconds: 30,
        },
      });
      check("execute_task отклонён для плана с вопросами", executeVague.isError === true);
    }

    console.log("\n14. Несуществующая модель");
    // Проверяет весь путь «параметр → argv → разбор ошибки». CLI отвергает такую
    // модель примерно за секунду и не тратит токенов, так что кейс дешёвый.
    const badModel = report(
      await client.callTool({
        name: "plan_task",
        arguments: {
          task_text: "Ответь одним словом.",
          project_dir: projectDir,
          model: "definitely-not-a-real-model-xyz",
          wait_seconds: 60,
        },
      }),
    );
    check("ok=false", badModel.ok === false, `статус: ${badModel.status}`);
    check("api_error_status = 404", badModel.api_error_status === 404, `получено: ${badModel.api_error_status}`);
    check(
      "model_requested сохранён",
      badModel.model_requested === "definitely-not-a-real-model-xyz",
      `получено: ${badModel.model_requested}`,
    );
    check(
      "подсказка указывает на модель",
      typeof badModel.hint === "string" && /модел/i.test(badModel.hint),
      badModel.hint ?? "(пусто)",
    );

    console.log("\n15. Живая отмена: cancel_task посреди работы");
    // Единственное, чего не снять фикстурой: убийство живого процесса посреди
    // потока. Офлайн (2n) buildTerminalHint гоняется на синтетических снимках,
    // но что мост подставляет эту подсказку в hint отчёта, что session_id
    // восстанавливается из строки system/init и что progress доживает до
    // ответа cancel_task — видно только на настоящем прогоне.
    const surveyDir = join(projectDir, "survey");
    mkdirSync(surveyDir, { recursive: true });
    for (let i = 1; i <= 12; i++) {
      const name = `mod-${String(i).padStart(2, "0")}`;
      // Отдельный подкаталог, а не корень проекта: корень к этому моменту
      // засорён секциями 2f/2g, включая симлинк-петлю loopdir/self.
      const body = [`# ${name}`, `retries = ${i}`, `timeout_ms = ${i * 1000}`];
      for (let k = 0; k < 24; k++) body.push(`${name}.option_${k} = value-${(i * 31 + k) % 97}`);
      writeFileSync(join(surveyDir, `${name}.txt`), `${body.join("\n")}\n`);
    }

    const startedLong = report(
      await client.callTool({
        name: "plan_task",
        arguments: {
          task_text:
            "Составь план унификации настроек. Обязательное требование к процессу: изучи КАЖДЫЙ " +
            "файл в каталоге survey/ (их двенадцать) отдельным вызовом Read, по одному файлу за " +
            "вызов, и после каждого прочитанного файла коротко выпиши, какие параметры в нём " +
            "заданы. Не используй Glob, Grep и Bash, не читай файлы пачками и не сокращай обход.",
          project_dir: projectDir,
          model: "sonnet",
          // session_id не передаём намеренно: тогда requestedSessionId === null,
          // и единственный возможный источник session_id в отчёте отменённой
          // задачи — строка system/init потока.
          wait_seconds: 0,
        },
      }),
    );
    check("долгая задача запущена", startedLong.status === "running", `статус: ${startedLong.status}`);

    // Отменяем по факту наблюдаемого прогресса, а не по таймеру: отмена «через
    // пару секунд» могла бы застать нулевые счётчики, и проверка подсказки
    // выродилась бы в проверку заглушки.
    const MIN_TOOL_CALLS = 3;
    let live = startedLong;
    for (
      let i = 0;
      i < 30 && live.status === "running" && live.progress.tool_calls < MIN_TOOL_CALLS;
      i++
    ) {
      live = report(
        await client.callTool({
          name: "get_task_status",
          arguments: { process_id: startedLong.process_id, wait_seconds: 2 },
        }),
      );
    }

    const readyToCancel = live.status === "running" && live.progress.tool_calls >= MIN_TOOL_CALLS;
    check(
      "задача дожила до отмены с реальным прогрессом",
      readyToCancel,
      `статус: ${live.status}, вызовов инструментов: ${live.progress.tool_calls}`,
    );

    if (readyToCancel) {
      const canceled = report(
        await client.callTool({
          name: "cancel_task",
          arguments: { process_id: startedLong.process_id },
        }),
      );
      console.log(`  hint отменённой задачи: ${canceled.hint}`);

      check("статус canceled", canceled.status === "canceled", `получено: ${canceled.status}`);
      check(
        "session_id восстановлен из потока",
        typeof canceled.session_id === "string" && canceled.session_id.length > 0,
        `получено: ${canceled.session_id}`,
      );
      check(
        "итогового отчёта CLI нет",
        canceled.result_text === null,
        String(canceled.result_text).slice(0, 200),
      );
      check(
        "стоимость отменённой задачи неизвестна",
        canceled.total_cost_usd === null,
        `получено: ${canceled.total_cost_usd}`,
      );
      check(
        "прогресс отменённой задачи не потерян",
        canceled.progress.streaming === true &&
          canceled.progress.tool_calls > 0 &&
          typeof canceled.progress.last_tool_call?.name === "string" &&
          canceled.progress.last_tool_call.name.length > 0 &&
          canceled.progress.recent_events.length >= 1,
        JSON.stringify({
          streaming: canceled.progress.streaming,
          tool_calls: canceled.progress.tool_calls,
          last_tool_call: canceled.progress.last_tool_call,
          recent_events: canceled.progress.recent_events.length,
        }),
      );
      // hint и progress строятся по одному снимку (buildReport читает часы один
      // раз), поэтому счётчик в тексте обязан совпадать с полем отчёта: так
      // проверка ловит их рассинхрон, а не повторяет саму себя.
      check(
        "hint перечисляет, что успело произойти, а не заглушку парсера",
        typeof canceled.hint === "string" &&
          canceled.hint.startsWith("Задача остановлена через") &&
          canceled.hint.includes(`вызовов инструментов ${canceled.progress.tool_calls}`) &&
          typeof canceled.progress.last_tool_call?.name === "string" &&
          canceled.hint.includes(canceled.progress.last_tool_call.name) &&
          canceled.hint.includes("session_id сохранён") &&
          !canceled.hint.includes("JSON-отчёт не сформирован"),
        canceled.hint ?? "(пусто)",
      );

      // Отмена — контрольная точка, а не выброшенная работа: повторный опрос
      // отдаёт то же состояние с замороженным временем.
      const afterCancel = report(
        await client.callTool({
          name: "get_task_status",
          arguments: { process_id: startedLong.process_id },
        }),
      );
      check(
        "состояние отменённой задачи заморожено и переживает повторный опрос",
        afterCancel.status === "canceled" &&
          afterCancel.session_id === canceled.session_id &&
          afterCancel.progress.elapsed_ms === canceled.progress.elapsed_ms,
        `${canceled.progress.elapsed_ms} → ${afterCancel.progress.elapsed_ms}`,
      );
    }

    // Реальное доказательство, что --verbose не сорит в stdout: после всех
    // живых прогонов, включая отменённый, в логе не должно быть ни одной
    // записи о сбое разбора потока. Когда формат stream-json дочернего CLI
    // поедет, падёт именно эта проверка — офлайновые фикстуры этого не увидят.
    const liveLog = readFileSync(join(workspace, "logs", "ccc-mcp.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    check(
      "живые прогоны не дали ни одной записи stream_warn",
      !liveLog.some((l) => l.event === "stream_warn"),
      JSON.stringify(liveLog.filter((l) => l.event === "stream_warn")),
    );
  }

  console.log(`\nИтог: ${passed} прошло, ${failed} провалено`);
  console.log(`Лог вызовов: ${join(workspace, "logs", "ccc-mcp.jsonl")}`);
} finally {
  await client.close().catch(() => {});
}

if (failed === 0) {
  rmSync(workspace, { recursive: true, force: true });
}
process.exit(failed === 0 ? 0 : 1);

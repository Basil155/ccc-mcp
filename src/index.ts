#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { z } from "zod";

import { ConfigError, loadConfig, type Config } from "./config.js";
import { isNested, NESTED_ENV_VAR } from "./env.js";
import { diagnose, type Diagnosis } from "./diagnose.js";
import { listProjectFiles, normalizeExtensions } from "./fileList.js";
import { FileOpError, readProjectFile, writeProjectFile } from "./fileOps.js";
import { GIT_OPERATIONS, GitOpError, probeGit, runGitOperation } from "./gitOps.js";
import {
  HookBridge,
  PermissionRequestError,
  type PermissionRequest,
  type RequestDecision,
} from "./hookBridge.js";
import {
  JobRegistry,
  SessionBusyError,
  waitForJob,
  type Job,
  type JobStatus,
  type WaitReason,
} from "./jobs.js";
import { Logger, preview } from "./logger.js";
import { parseClaudeOutput, type ParsedResult } from "./parser.js";
import { ProjectDirError, ProjectFileError, validateProjectDir } from "./paths.js";
import { JobProgress } from "./progress.js";
import {
  buildStreamDriftHint,
  buildTerminalHint,
  progressLogFields,
  toProgressView,
  type ProgressView,
} from "./progressView.js";
import { EXECUTE_SYSTEM_PROMPT, OPEN_QUESTIONS_HEADING, PLAN_SYSTEM_PROMPT } from "./prompts.js";
import { ClaudeRunner, SpawnError } from "./runner.js";
import {
  ApprovalError,
  SessionRegistry,
  type SessionRecord,
  type SessionState,
} from "./sessions.js";

const PERMISSION_MODES = ["acceptEdits", "bypassPermissions"] as const;

/**
 * Инструменты под хуком в plan_task — независимо от sensitiveTools.
 *
 * Правку файлов plan-режим CLI и так запрещает (кроме файла плана), а вот
 * запуск команд — нет: Bash и Monitor исполняют произвольный shell, и правила
 * permissions.allow пользователя пропускают их без вопросов. 23.09 так прошли
 * docker compose down/up, запись в redis и перезапись двух файлов через
 * python3 -c — всё внутри plan_task.
 */
const PLAN_SENSITIVE_TOOLS = ["Bash", "Monitor"];

/**
 * Версия берётся из package.json на старте, а не дублируется строкой: иначе bump
 * версии при публикации разъедется с тем, что сервер объявляет клиенту.
 * Путь общий для src/index.ts и dist/index.js — rootDir "src" даёт плоский dist,
 * оба файла лежат на уровень ниже корня пакета.
 */
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** Запрос на разрешение в виде, пригодном для показа пользователю. */
interface PermissionRequestView {
  request_id: string;
  tool_name: string;
  summary: string;
  decision: RequestDecision;
  /** Сколько раз хук ответил отказом. Вызов, одобренный во время удержания, отказом не считается. */
  denied_count: number;
  allowed_count: number;
  first_seen_at: string;
  last_seen_at: string;
  /** Отказ выдал мост: оператор не выходил на связь дольше operatorAbsentMinutes. */
  operator_absent: boolean;
}

function toPermissionView(r: PermissionRequest): PermissionRequestView {
  return {
    request_id: r.requestId,
    tool_name: r.toolName,
    summary: r.summary,
    decision: r.decision,
    denied_count: r.deniedCount,
    allowed_count: r.allowedCount,
    first_seen_at: new Date(r.firstSeenAt).toISOString(),
    last_seen_at: new Date(r.lastSeenAt).toISOString(),
    operator_absent: r.operatorAbsent,
  };
}

/** Ответ инструмента — единая форма для задач. */
interface ToolReport {
  process_id: string;
  status: JobStatus;
  ok: boolean;
  session_id: string | null;
  /** Где сессия в протоколе «план → одобрение → выполнение». */
  session_state: SessionState | null;
  /** Отпечаток плана, который нужно передать в approve_plan. */
  plan_digest: string | null;
  /** В ответе есть раздел «Открытые вопросы»: модели не хватило информации. */
  has_open_questions: boolean;
  result_text: string | null;
  is_error: boolean | null;
  subtype: string | null;
  api_error_status: number | null;
  terminal_reason: string | null;
  hint: string | null;
  num_turns: number | null;
  duration_ms: number | null;
  total_cost_usd: number | null;
  permission_denials: unknown[];
  /** Что мост передал в --model. null — флаг не передавался, решал сам CLI. */
  model_requested: string | null;
  /** Что отработало на самом деле: алиас уже развёрнут, виден и fallback. */
  model_used: string | null;
  exit_code: number | null;
  parse_error: string | null;
  project_dir: string;
  raw: Record<string, unknown> | null;
  /**
   * Запросы на разрешение, накопленные за всё время выполнения задачи.
   *
   * Пустой массив при выключенных хуках — форма отчёта не «мигает» между режимами.
   */
  permission_requests: PermissionRequestView[];
  /** Сколько из них ждут решения оператора прямо сейчас. */
  pending_permission_count: number;
  /**
   * Живое состояние задачи по потоку событий дочернего CLI.
   *
   * Всегда объект, никогда null: при выключенном потоке и у задач, не давших ни
   * одной строки, это нули и пустые карты — форма отчёта не «мигает». У
   * завершённой задачи значения заморожены на моменте завершения.
   */
  progress: ProgressView;
  /**
   * Почему вернулось ожидание: задача завершилась, вышло время или появился
   * запрос на разрешение. null — ожидания в этом вызове не было.
   */
  wait_ended_reason: WaitReason | null;
  /** Что делать дальше — подсказка вызывающему агенту. */
  next_step: string | null;
}

function buildReport(
  job: Job,
  session: SessionRecord | null = null,
  opts: { streamEnabled: boolean; waitEndedReason: WaitReason | null } = {
    streamEnabled: false,
    waitEndedReason: null,
  },
): ToolReport {
  const r: ParsedResult | null = job.result;
  const stillRunning = job.status === "running";
  const permissions = job.bridge?.list() ?? [];
  const pendingPermissions = permissions.filter((p) => p.decision === "pending").length;

  // Часы читаются один раз на отчёт: снимок, диагноз и подсказка обязаны
  // описывать один и тот же момент, иначе idle_seconds и фраза паттерна
  // разойдутся между собой на время сборки ответа.
  const now = Date.now();
  const snapshot = job.progress.snapshot(now);
  const diagnosis = diagnose({
    tool: job.tool,
    processId: job.processId,
    now,
    snapshot,
    permissions,
    streamEnabled: opts.streamEnabled,
  });

  // Строка init даёт session_id примерно через секунду после спавна, а не в
  // конце прогона: благодаря этому отменённая и отвалившаяся по таймауту задача
  // остаётся возобновляемой. Порядок кандидатов — от самого достоверного.
  const sessionId = r?.sessionId ?? snapshot.sessionId ?? job.requestedSessionId;

  return {
    process_id: job.processId,
    status: job.status,
    ok: r?.ok ?? false,
    session_id: sessionId,
    session_state: session?.state ?? null,
    plan_digest: session?.planDigest ?? null,
    has_open_questions: r?.hasOpenQuestions ?? false,
    result_text: r?.resultText ?? null,
    is_error: r?.isError ?? null,
    subtype: r?.subtype ?? null,
    api_error_status: r?.apiErrorStatus ?? null,
    terminal_reason: r?.terminalReason ?? null,
    // У остановленной задачи подсказка парсера формально верна («JSON-отчёт не
    // сформирован»), но не сообщает ничего. Заменяем её на то, что мост успел
    // увидеть сам; result_text при этом остаётся null — частичный результат
    // планом одобрить нельзя (см. progressView.buildTerminalHint).
    hint:
      job.status === "canceled" || job.status === "timeout"
        ? buildTerminalHint({
            status: job.status,
            snapshot,
            // Пустая строка — это «отчёта нет»: отправлять к result_text, в
            // котором ничего нет, хуже, чем показать собственные наблюдения.
            hasResultText: (r?.resultText ?? "").length > 0,
            sessionId,
          })
        : // Итогового JSON нет и поток при этом сорил: подсказка парсера тут
          // отправляет проверять авторизацию, а причина — расхождение формата.
          (r !== null && r.parseError !== null ? buildStreamDriftHint(snapshot) : null) ??
          r?.hint ??
          null,
    num_turns: r?.numTurns ?? null,
    duration_ms:
      r?.durationMs ?? (job.finishedAt !== null ? job.finishedAt - job.startedAt : null),
    total_cost_usd: r?.totalCostUsd ?? null,
    permission_denials: r?.permissionDenials ?? [],
    model_requested: job.model,
    // Основная модель прогона. Служебные (генерация заголовка и т. п.) сюда не
    // попадают, но целиком видны в raw.modelUsage.
    model_used: r?.modelsUsed?.[0] ?? null,
    exit_code: job.exitCode,
    parse_error: r?.parseError ?? null,
    project_dir: job.projectDir,
    raw: r?.raw ?? null,
    permission_requests: permissions.map(toPermissionView),
    pending_permission_count: pendingPermissions,
    progress: toProgressView(snapshot),
    wait_ended_reason: opts.waitEndedReason,
    next_step: buildNextStep(job, session, stillRunning, diagnosis),
  };
}

/** Подсказка вызывающему агенту: какой шаг протокола следующий. */
function buildNextStep(
  job: Job,
  session: SessionRecord | null,
  stillRunning: boolean,
  diagnosis: Diagnosis,
): string | null {
  if (stillRunning) {
    // Вызывающий агент видит задачу только через опрос статуса, поэтому именно
    // next_step обязан его подтолкнуть — иначе запрос провисит до бюджета.
    //
    // Когда паттерн обнаружен, его фраза строго информативнее общей: она уже
    // содержит process_id, имя инструмента, выжимку и рекомендацию действия.
    // Отдельная ветка про pending-разрешения здесь больше не нужна — её
    // покрывает паттерн pending_permission с тем же условием, но с именем
    // операции и возрастом запроса.
    if (diagnosis.message !== null) return diagnosis.message;
    return `Задача выполняется. Опросите её: get_task_status с process_id "${job.processId}" (можно с wait_seconds).`;
  }

  // Остановленная задача: состояние сессии тут — наименее полезное из того, что
  // можно сказать, поэтому ветка идёт до switch по нему.
  if (job.status === "canceled" || job.status === "timeout") {
    const how = job.status === "timeout" ? "прервана по таймауту" : "остановлена";
    return (
      `Задача ${how}, итогового отчёта Claude Code нет — result_text пуст, и одобрять как план ` +
      `тут нечего. Что успело произойти, видно в hint и progress (recent_events, tools_used, ` +
      `last_tool_call). Если работу нужно продолжить, начните новый цикл plan_task → approve_plan ` +
      `→ execute_task` +
      (job.status === "timeout"
        ? `, разбив задачу на части поменьше.`
        : `; при необходимости передайте session_id из этого отчёта, чтобы продолжить ту же сессию.`)
    );
  }

  if (!session) return null;

  switch (session.state) {
    case "needs_clarification":
      return (
        `Плану не хватает информации: в ответе есть раздел «${OPEN_QUESTIONS_HEADING}». ` +
        `Прежде чем одобрять, уточните эти вопросы у пользователя, затем вызовите plan_task ` +
        `заново с уточнённой задачей. approve_plan для этой сессии работать не будет.`
      );
    case "planned":
      return (
        `План готов, но не одобрен — выполнение пока запрещено. Покажите план пользователю ` +
        `и, получив согласие, вызовите approve_plan с session_id "${session.sessionId}" ` +
        `и plan_digest "${session.planDigest}".`
      );
    case "approved":
      return (
        `План одобрен. Вызовите execute_task с session_id "${session.sessionId}" ` +
        `и тем же project_dir.`
      );
    case "executed":
      return (
        `План выполнен. Для следующей задачи начните новый цикл: plan_task → approve_plan → execute_task.`
      );
    default:
      return null;
  }
}

function toolResult(report: ToolReport) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
    structuredContent: report as unknown as Record<string, unknown>,
    isError: false,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/**
 * Синоним session_id во входах plan_task, approve_plan и execute_task.
 *
 * Прокси remote-devices в Cowork вырезает из аргументов ключ session_id до
 * пересылки локальному stdio-серверу: approve_plan приходил с одним
 * plan_digest (см. BUGREPORT-approve_plan-session_id-undefined.md). Второе
 * имя — обход этой платформенной ошибки на нашей стороне, а не её исправление.
 * session_id работает как прежде.
 */
const SESSION_ALIAS = "session";

/**
 * Схема входа с парой session_id / session.
 *
 * На уровне полей оба необязательны, а правила «хотя бы одно» (для required)
 * и «не расходятся» проверяет superRefine. Так отказ по-прежнему отдаёт SDK
 * как -32602 до хендлера — с той же формой сообщения и записью invalid_args,
 * — а хендлер получает уже согласованную пару и берёт её через sessionIdOf.
 */
function withSessionId<Shape extends z.ZodRawShape>(
  shape: Shape,
  opts: { required: boolean; description: string },
) {
  const field = z.string().min(1).optional();
  return z
    .object({
      ...shape,
      session_id: field.describe(opts.description),
      [SESSION_ALIAS]: field.describe(
        `Синоним session_id с тем же значением — для клиентов, чей прокси теряет ключ ` +
          `session_id. Передавайте одно из двух; если переданы оба, они должны совпадать.`,
      ),
    } as Shape & { session_id: typeof field; session: typeof field })
    .superRefine((args, ctx) => {
      const { session_id: id, session: alias } = args as { session_id?: string; session?: string };
      if (id !== undefined && alias !== undefined && id !== alias) {
        ctx.addIssue({
          code: "custom",
          path: ["session_id"],
          message: `session_id и ${SESSION_ALIAS} переданы с разными значениями — передайте одно из двух`,
        });
      } else if (opts.required && id === undefined && alias === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["session_id"],
          message:
            `Invalid input: expected string, received undefined ` +
            `(передайте session_id или его синоним ${SESSION_ALIAS})`,
        });
      }
    });
}

/** session_id из пары session_id / session, уже согласованной withSessionId. */
function sessionIdOf(args: { session_id?: string | undefined; session?: string | undefined }) {
  return args.session_id ?? args.session;
}

/** Каким именем пришёл session_id — для лога: так видно, сработал ли обход. */
function sessionParamOf(args: { session_id?: string | undefined; session?: string | undefined }) {
  if (args.session_id !== undefined) return "session_id";
  return args.session !== undefined ? SESSION_ALIAS : null;
}

/** Тип значения для лога: typeof, но массив и null различимы. */
function argKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Пишет в лог вызовы, отбитые проверкой inputSchema.
 *
 * SDK проверяет аргументы до хендлера и сам отвечает клиенту -32602, так что
 * без этой обёртки такой вызов не оставляет в логе ничего и выглядит так,
 * будто до процесса не дошёл (см. историю с прокси, терявшим session_id).
 * Пишутся только имена полученных ключей и типы значений: через аргументы
 * текут task_text и тела файлов, их место — не здесь.
 *
 * validateToolInput — приватный метод McpServer, публичного хука перед
 * валидацией у SDK нет. Если после обновления SDK метода не окажется,
 * обёртка отключается с предупреждением в stderr, а сервер работает как был.
 */
function logInvalidArgs(server: McpServer, logger: Logger): void {
  const target = server as unknown as {
    validateToolInput?: (tool: unknown, args: unknown, toolName: string) => Promise<unknown>;
  };
  const original = target.validateToolInput;
  if (typeof original !== "function") {
    logger.stderr("validateToolInput не найден в SDK: вызовы с невалидными аргументами не логируются");
    return;
  }
  target.validateToolInput = async function (tool, args, toolName) {
    try {
      return await original.call(this, tool, args, toolName);
    } catch (err) {
      const received =
        args !== null && typeof args === "object"
          ? Object.fromEntries(Object.entries(args).map(([k, v]) => [k, argKind(v)]))
          : argKind(args);
      logger.write({
        event: "invalid_args",
        tool: toolName,
        received,
        message: preview(err instanceof Error ? err.message : String(err), 500),
      });
      throw err;
    }
  };
}

async function main(): Promise<void> {
  // До загрузки конфига и пробы claude: вложенному мосту не нужно ни то, ни
  // другое, а проба сама порождала бы процесс claude. Код выхода ненулевой, чтобы
  // дочерний CLI показал сервер как упавший с этой причиной, а не как пустой.
  if (isNested()) {
    process.stderr.write(
      `[ccc-mcp] запущен внутри дочернего Claude Code моста (${NESTED_ENV_VAR}) — ` +
        `вложенный мост отключён: он дал бы дочернему процессу запуск новых claude ` +
        `и git/запись файлов мимо контроля разрешений.\n`,
    );
    process.exit(1);
    return;
  }

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : String(err);
    process.stderr.write(`[ccc-mcp] не удалось загрузить конфигурацию:\n${message}\n`);
    process.exit(1);
    return;
  }

  const logger = new Logger(config.resolvedLogFile);
  const runner = new ClaudeRunner(config, logger);

  try {
    runner.probe();
  } catch (err) {
    const message = err instanceof SpawnError ? err.message : String(err);
    logger.write({ event: "error", stage: "probe", message });
    process.stderr.write(`[ccc-mcp] проверка Claude Code не прошла:\n${message}\n`);
    process.exit(1);
    return;
  }

  // Проба git — сознательно не фатальная: остальные восемь инструментов от него
  // не зависят, и ронять из-за него сервер было бы неверно. Но оператор должен
  // узнать о проблеме из лога старта, а не при первом вызове run_git.
  const git = probeGit(config.gitBin);
  logger.write({
    event: "startup",
    component: "git",
    git_bin: git.bin,
    git_version: git.version,
    git_error: git.error,
    max_diff_bytes: config.maxDiffBytes,
    git_timeout_ms: config.gitTimeoutMs,
  });
  if (git.error !== null) {
    logger.stderr(`git недоступен, инструмент run_git работать не будет: ${git.error}`);
  }

  const jobs = new JobRegistry(config.jobRetentionMs);
  // Граница памяти реестра задач: всё, что стартовало раньше, в нём не найти.
  const serverStartedAt = Date.now();
  const sessions = new SessionRegistry(config.sessionRetentionMs);

  logger.stderr(
    `claude ${runner.claudeVersion}; --sandbox ${
      runner.supportsSandbox ? "поддерживается" : "не поддерживается"
    }; корней в белом списке: ${config.resolvedRoots.length}; конфиг: ${config.source}`,
  );

  const server = new McpServer(
    { name: "ccc-mcp", version: SERVER_VERSION },
    {
      instructions:
        "Мост к локальной установке Claude Code. В начале работы вызовите get_bridge_info: он " +
        "вернёт версию моста и настройки, от которых зависит ваша работа с ним (таймауты, контроль " +
        "разрешений, списки автоодобрения, допустимые каталоги, лимиты). " +
        "Действует обязательный протокол из трёх шагов: " +
        "1) plan_task — получить план. Это разведка, а не песочница: правку файлов режим плана " +
        "запрещает, но Bash-команды выполняются по правилам разрешений пользователя, поэтому при " +
        "включённом контроле разрешений они, как и в execute_task, ждут решения оператора; " +
        "не отправляйте в plan_task задачу «выполни» — только «спланируй»; " +
        "2) показать план пользователю и, получив согласие, вызвать approve_plan с session_id и plan_digest из ответа plan_task; " +
        "3) execute_task с тем же session_id — выполнение. " +
        "Во всех трёх инструментах session_id можно передать и под синонимом session (одно из двух " +
        "имён; если переданы оба, значения должны совпадать) — это обход для клиентов, чей прокси " +
        "теряет ключ session_id. " +
        "execute_task без одобренного плана всегда отклоняется, запустить его «с нуля» нельзя. " +
        "Повторный plan_task сбрасывает одобрение. После успешного выполнения нужен новый цикл. " +
        "Интерактивные вопросы недоступны: если Claude Code не хватило информации, ответ содержит " +
        "раздел «Открытые вопросы» и has_open_questions: true — такой план одобрять нельзя, " +
        "задайте эти вопросы пользователю и вызовите plan_task заново с уточнённой задачей. " +
        "Долгие задачи уходят в фон: если пришёл status \"running\", опрашивайте get_task_status по process_id. " +
        "Если ответ plan_task или execute_task потерялся (оборвалось соединение, истёк таймаут клиента), " +
        "не запускайте задачу заново: list_tasks покажет идущие и недавние задачи с их process_id. " +
        "Идущая задача не чёрный ящик: в каждом ответе есть progress — вызовы инструментов, " +
        "tools_used, last_tool_call, последнее видимое сообщение модели, idle_seconds и лента " +
        "recent_events, а next_step называет то, что с задачей происходит прямо сейчас " +
        "(ждёт разрешения, зависла, выполняет долгий инструмент, повторяет один и тот же вызов). " +
        "Стоимость известна только по завершении: пока задача идёт, total_cost_usd равен null. " +
        "Остановка через cancel_task теперь не выбрасывает сделанное: итогового отчёта у неё нет, " +
        "но hint перечисляет, что успело произойти, а session_id известен — ту же сессию можно " +
        "продолжить новым циклом. " +
        "Если включён контроль разрешений, get_task_status может вернуть permission_requests с " +
        "decision \"pending\" — это операции, которые дочерний Claude Code хочет выполнить прямо " +
        "сейчас. Покажите их пользователю и проведите через approve_permission_request: без решения " +
        "они будут отклонены. Опрашивайте идущую задачу хотя бы раз в несколько минут: если к ней " +
        "долго никто не обращается, мост считает оператора ушедшим и отклоняет её запросы сам " +
        "(operator_absent: true), а задача продолжает без этих операций. " +
        "Отдельно от этого протокола есть три файловых инструмента: list_project_files, " +
        "read_project_file и write_project_file работают с файлами проекта напрямую, без " +
        "запуска Claude Code и без цикла план → одобрение → выполнение. Используйте их, когда " +
        "нужно просто показать пользователю файл вроде CLAUDE.md или положить обратно " +
        "согласованную с ним версию: гонять это через plan_task/execute_task — лишние токены и " +
        "время. Если точный путь неизвестен, начните с list_project_files — он покажет дерево " +
        "проекта (без node_modules, .git и прочего игнорируемого) и умеет искать по имени " +
        "параметрами name_contains и extensions. " +
        "Так же вне протокола работает run_git: фиксированный набор git-операций (status, log, " +
        "diff, branch_list, branch_create, add_commit, checkout_branch) выполняется напрямую, " +
        "без запуска Claude Code. Берите его для механической работы с git — посмотреть статус, " +
        "закоммитить согласованные правки, создать ветку: через plan_task/execute_task это стоит " +
        "токенов и минут на операцию, не требующую интеллекта. project_dir должен быть корнем " +
        "репозитория. Операций push/pull/reset/rebase/merge там нет вовсе. Если success: false — " +
        "это ответ самого git (нечего коммитить, грязное дерево), покажите пользователю git_stderr. " +
        "Для правок кода по-прежнему нужен полный протокол.",
    },
  );
  logInvalidArgs(server, logger);

  /**
   * Сессии, по которым задача уже запускается, но Job ещё не создан.
   *
   * Между проверкой занятости и jobs.create в startTask есть await (подъём моста
   * хуков, спавн), и без этой брони второй вызов с тем же session_id прошёл бы
   * проверку в этом окне.
   */
  const startingSessions = new Set<string>();

  /**
   * Отказ, если сессию уже продолжает идущая задача или она сейчас запускается.
   *
   * Синхронная: вызывается до первого await в startTask, поэтому проверка и
   * бронь неделимы. Для execute_task вызывается ещё и до beginExecution, чтобы
   * отказ не трогал состояние одобрения.
   */
  function assertSessionIdle(sessionId: string): void {
    const running = jobs.findRunningBySession(sessionId);
    if (running) {
      const seconds = Math.round((Date.now() - running.startedAt) / 1000);
      throw new SessionBusyError(
        `сессию ${sessionId} уже продолжает задача ${running.processId} (${running.tool}, ` +
          `идёт ${seconds} с). Два прогона одной сессии пишут в один транскрипт и перемешивают ` +
          `ходы, поэтому второй не запускается. Дождитесь её завершения через get_task_status ` +
          `с process_id "${running.processId}" или остановите её cancel_task, затем повторите вызов.`,
      );
    }
    if (startingSessions.has(sessionId)) {
      throw new SessionBusyError(
        `по сессии ${sessionId} прямо сейчас запускается другая задача. Повторите вызов через ` +
          `несколько секунд: к тому времени у неё будет process_id для get_task_status.`,
      );
    }
  }

  /** Общий запуск задачи для plan_task и execute_task. */
  async function startTask(params: {
    tool: "plan_task" | "execute_task";
    taskText: string;
    projectDir: string;
    sessionId?: string | undefined;
    permissionMode: string;
    model?: string | undefined;
    waitSeconds: number;
  }) {
    const cwd = validateProjectDir(params.projectDir, config.resolvedRoots);

    // До первого await: проверка и бронь неделимы (см. startingSessions).
    const resumeId = params.sessionId;
    if (resumeId !== undefined) {
      assertSessionIdle(resumeId);
      startingSessions.add(resumeId);
    }
    try {
      return await spawnTask(params, cwd);
    } finally {
      // К этому моменту Job либо создан (и дальше сессию держит он), либо запуск
      // не удался — в обоих случаях бронь больше не нужна.
      if (resumeId !== undefined) startingSessions.delete(resumeId);
    }
  }

  /** Тело startTask после проверки каталога и брони сессии. */
  async function spawnTask(params: Parameters<typeof startTask>[0], cwd: string) {
    // Разрешаем один раз: это же значение уходит в argv, отчёт и лог.
    const model = runner.resolveModel(params.model);

    // Мост поднимаем ДО спавна: порт выдаёт ОС, а он нужен уже в --settings.
    // И для plan_task тоже: plan-режим CLI не изолирует Bash (см.
    // PLAN_SENSITIVE_TOOLS). Читающие команды мост пропускает сам
    // (planAutoApproveReadOnly), остальные идут оператору, кроме своего списка
    // planAutoApproveCommands.
    const isPlan = params.tool === "plan_task";
    const hookTools = isPlan ? PLAN_SENSITIVE_TOOLS : config.sensitiveTools;
    const bridge = config.hooksEnabled
      ? await HookBridge.start({
          sensitiveTools: hookTools,
          retryBudget: config.retryBudget,
          maxPendingRequests: config.maxPendingRequests,
          allowWaitCommand: config.allowWaitCommand,
          autoApproveCommands: isPlan ? config.planAutoApproveCommands : config.autoApproveCommands,
          autoApproveReadOnly: isPlan
            ? config.planAutoApproveReadOnly
            : config.executeAutoApproveReadOnly,
          // Job появится после спавна; до этого оператор заведомо на связи —
          // он только что запустил задачу.
          operatorAbsentMs: () => {
            if (logJob === null || config.operatorAbsentMinutes === 0) return null;
            const silent = Date.now() - logJob.lastOperatorContactAt;
            return silent > config.operatorAbsentMinutes * 60_000 ? silent : null;
          },
          holdMs: config.permissionHoldSeconds * 1000,
          logger,
        })
      : null;

    const args = runner.buildTaskArgs({
      permissionMode: params.permissionMode,
      taskText: params.taskText,
      sessionId: params.sessionId,
      model: params.model,
      appendSystemPrompt:
        params.tool === "plan_task" ? PLAN_SYSTEM_PROMPT : EXECUTE_SYSTEM_PROMPT,
      hookUrl: bridge?.url,
      hookTools,
      stream: config.streamEvents,
    });

    // Прогресс создаётся ДО спавна: колбэк уходит внутрь run(), поэтому окна, в
    // котором первые события потока уже пришли, а копить их некуда, нет вовсе.
    // Тот же порядок, что у моста: сначала объект, потом Job.
    const progress = new JobProgress(Date.now());

    // Job появляется только после спавна, а лог прогресса зовётся из колбэка
    // событий. Ссылку выставляем сразу после create: до этого момента сводку
    // писать не о чем — в ней нет даже process_id.
    let logJob: Job | null = null;
    let lastProgressLogAt = Date.now();

    /**
     * Периодическая сводка живого состояния.
     *
     * Логируется не событие, а состояние по времени: событий у дочернего CLI
     * десятки в секунду. Таймера нет намеренно — его пришлось бы создавать,
     * unref-ать и гасить на четырёх путях завершения, а так запись затихает
     * вместе с потоком, и молчание в логе само по себе информативно.
     */
    function maybeLogProgress(): void {
      if (logJob === null) return;
      const now = Date.now();
      if (now - lastProgressLogAt < config.logProgressIntervalMs) return;
      lastProgressLogAt = now;
      const snapshot = progress.snapshot(now);
      logger.write({
        event: "progress",
        process_id: logJob.processId,
        tool: logJob.tool,
        elapsed_ms: snapshot.elapsedMs,
        pending_permissions: logJob.bridge?.list().filter((p) => p.decision === "pending").length ?? 0,
        ...progressLogFields(snapshot),
      });
    }

    let handle;
    try {
      handle = runner.run({
        args,
        cwd,
        timeoutMs: config.timeoutMs,
        // При streamEvents: false колбэков нет, и раннер остаётся на буферном
        // пути — argv в этом случае тоже прежний, --output-format json.
        onEvent: config.streamEvents
          ? config.logProgress
            ? (ev) => {
                progress.ingest(ev);
                maybeLogProgress();
              }
            : (ev) => progress.ingest(ev)
          : undefined,
        onBadLine: config.streamEvents
          ? (chars, reason) => progress.noteBadLine(chars, reason)
          : undefined,
        // Опознавательные поля для записей stream_warn. Замыканием, потому что
        // на момент вызова run() ни process_id, ни session_id ещё не
        // существуют: та же уловка с logJob, что у maybeLogProgress.
        warnContext: config.streamEvents
          ? () => ({
              processId: logJob?.processId ?? null,
              tool: logJob?.tool ?? null,
              // Единственный источник истины про session_id — снимок прогресса.
              sessionId: progress.snapshot().sessionId,
            })
          : undefined,
      });
    } catch (err) {
      // Процесс не стартовал — иначе мост остался бы слушать порт навсегда.
      bridge?.stopListening();
      throw err;
    }

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((res) => {
      resolveCompletion = res;
    });

    const job = jobs.create({
      tool: params.tool,
      projectDir: cwd,
      permissionMode: params.permissionMode,
      model,
      taskPreview: preview(params.taskText, config.logTaskTextChars),
      requestedSessionId: params.sessionId ?? null,
      pid: handle.pid,
      cancel: handle.cancel,
      completion,
      bridge,
      progress,
    });
    logJob = job;
    bridge?.attachProcessId(job.processId);

    logger.write({
      event: "start",
      process_id: job.processId,
      tool: job.tool,
      project_dir: cwd,
      permission_mode: job.permissionMode,
      model: job.model,
      resume_session_id: job.requestedSessionId,
      sandbox: runner.shouldPassSandbox(),
      hooks: bridge !== null,
      sensitive_tools: bridge ? hookTools : null,
      task_preview: job.taskPreview,
      pid: handle.pid,
    });

    // Обработка завершения живёт независимо от того, ждёт ли её вызывающий.
    void handle.done.then((outcome) => {
      // Время останавливается на завершении процесса: иначе отчёт по задаче,
      // закончившейся 40 минут назад, заявил бы 2400 секунд простоя.
      job.progress.freeze(outcome.finishedAt);

      const parsed = parseClaudeOutput({
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        killed: outcome.killed,
      });

      let status: JobStatus;
      if (outcome.timedOut) status = "timeout";
      else if (outcome.killed) status = "canceled";
      else status = parsed.ok ? "done" : "failed";

      jobs.complete(job, status, parsed, outcome.exitCode);
      // Единственное место закрытия моста: обработчик срабатывает при любом
      // исходе — завершение, таймаут, cancel_task, ошибка спавна. Карта
      // запросов при этом сохраняется для отчёта.
      job.bridge?.stopListening();

      // Переходы состояний протокола.
      if (params.tool === "plan_task") {
        // Новый план — только при успехе. Всегда сбрасывает прежнее одобрение.
        const sessionId = parsed.sessionId ?? job.requestedSessionId;
        if (parsed.ok && sessionId) {
          // План с открытыми вопросами попадает в needs_clarification и
          // одобрению не подлежит.
          sessions.recordPlanned(
            sessionId,
            job.projectDir,
            parsed.resultText ?? "",
            parsed.hasOpenQuestions,
          );
        }
      } else if (job.requestedSessionId) {
        // Одобрение занято на время выполнения: при успехе расходуется,
        // при сбое возвращается, чтобы не проходить весь цикл заново.
        sessions.finishExecution(job.requestedSessionId, parsed.ok);
      }

      // Снимок уже заморожен выше, поэтому idle_seconds в записи означает
      // простой на момент завершения, а не время, прошедшее с тех пор.
      const finalSnapshot = job.progress.snapshot();

      logger.write({
        event: outcome.timedOut ? "timeout" : "finish",
        process_id: job.processId,
        tool: job.tool,
        project_dir: job.projectDir,
        status,
        ok: parsed.ok,
        // У остановленной задачи итогового JSON нет, но строка init была:
        // именно этот идентификатор позволяет продолжить прогон позже.
        session_id: parsed.sessionId ?? finalSnapshot.sessionId,
        session_state:
          sessions.get(parsed.sessionId ?? job.requestedSessionId ?? "")?.state ?? null,
        has_open_questions: parsed.hasOpenQuestions,
        is_error: parsed.isError,
        subtype: parsed.subtype,
        terminal_reason: parsed.terminalReason,
        api_error_status: parsed.apiErrorStatus,
        exit_code: outcome.exitCode,
        num_turns: parsed.numTurns,
        model_used: parsed.modelsUsed[0] ?? null,
        duration_ms: outcome.finishedAt - outcome.startedAt,
        total_cost_usd: parsed.totalCostUsd,
        parse_error: parsed.parseError,
        permission_requests: job.bridge?.list().length ?? 0,
        permission_unapproved:
          job.bridge?.list().filter((p) => p.decision !== "approved").length ?? 0,
        // Счётчики потока — всегда, без флага: несколько ключей в одной строке
        // на задачу, и именно они делают видимым между прогонами, металась ли
        // модель по инструментам.
        ...progressLogFields(finalSnapshot),
        ...(config.logResultText ? { result_text: parsed.resultText } : {}),
      });

      resolveCompletion();
    });

    // Досрочный выход на новом запросе разрешения: иначе операция, поднятая
    // через секунду после старта, ждала бы весь wait_seconds — причём ещё до
    // того, как у вызывающего появится process_id для опроса.
    const waitReason = await waitForJob(job, params.waitSeconds, {
      wakeOnPendingPermission: true,
    });
    return toolResult(reportFor(job, waitReason));
  }

  /** Отчёт по задаче вместе с актуальным состоянием её сессии. */
  function reportFor(job: Job, waitEndedReason: WaitReason | null = null): ToolReport {
    // Тот же порядок кандидатов, что и у session_id в отчёте: из потока
    // идентификатор известен уже через секунду после спавна.
    const sessionId =
      job.result?.sessionId ?? job.progress.snapshot().sessionId ?? job.requestedSessionId;
    return buildReport(job, sessionId ? sessions.get(sessionId) ?? null : null, {
      streamEnabled: config.streamEvents,
      waitEndedReason,
    });
  }

  /** Единый перевод исключений в понятный текст ошибки. */
  function describeError(err: unknown): string {
    if (err instanceof ApprovalError) return `Отказано: ${err.message}`;
    if (err instanceof ProjectDirError) return `Отказано: ${err.message}`;
    if (err instanceof SessionBusyError) return `Отказано: ${err.message}`;
    if (err instanceof ProjectFileError) return `Отказано: ${err.message}`;
    if (err instanceof PermissionRequestError) return `Отказано: ${err.message}`;
    // Операционные отказы файловых тулов — это не политика, префикс тут врал бы.
    if (err instanceof FileOpError) return err.message;
    // По той же причине без префикса: «ветка не найдена» — не отказ в доступе.
    if (err instanceof GitOpError) return err.message;
    if (err instanceof SpawnError) return `Не удалось запустить Claude Code: ${err.message}`;
    return `Внутренняя ошибка: ${err instanceof Error ? err.message : String(err)}`;
  }

  const waitSecondsSchema = z
    .number()
    .int()
    .min(0)
    .max(120)
    .optional()
    .describe(
      "Сколько секунд подождать результат перед уходом в фон. По умолчанию значение из конфига " +
        "(обычно 20). 0 — вернуть process_id сразу. Ожидание прерывается досрочно, если задача " +
        "запросила разрешение на операцию: тогда ответ придёт раньше срока со status \"running\" " +
        "и непустым permission_requests.",
    );

  /**
   * Имя модели для --model.
   *
   * Списка допустимых моделей здесь намеренно нет: он устарел бы быстрее, чем мост,
   * и запретил бы алиасы и новые модели. Неизвестную модель CLI отвергает сам —
   * за секунду, без расхода токенов и с понятным текстом, который доезжает
   * в result_text и hint.
   *
   * Regex решает другую задачу: значение уходит в argv соседом к "--model", и
   * строка вида "--dangerously-skip-permissions" была бы попыткой протащить флаг.
   * Первый символ обязан быть буквенно-цифровым — этим она и отсекается.
   * Shell-инъекция невозможна и так: spawn идёт с shell: false.
   */
  const modelSchema = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/, "недопустимое имя модели")
    .optional()
    .describe(
      "Модель для дочернего claude: алиас ('opus', 'sonnet', 'haiku') или полное имя " +
        "('claude-opus-5'). По умолчанию — модель из конфига моста.",
    );

  server.registerTool(
    "plan_task",
    {
      title: "Спланировать задачу",
      description:
        "Запускает Claude Code в режиме планирования (--permission-mode plan): он изучает проект " +
        "и возвращает план. Это не песочница: режим плана запрещает правку файлов, но не запуск " +
        "команд — Bash выполняется по правилам разрешений пользователя (permissions.allow). " +
        "Поэтому при включённом контроле разрешений (hooksEnabled) Bash-команды, которые не " +
        "только читают, ждут решения оператора: опрашивайте get_task_status и проводите " +
        "permission_requests через approve_permission_request, как для execute_task. " +
        "Задачу «выполни» сюда не отправляйте: план строится, работа не делается. " +
        "Интерактивные вопросы в этом режиме запрещены: " +
        "если информации не хватает, план придёт с разделом «Открытые вопросы» и полем " +
        "has_open_questions: true. Такой план одобрить нельзя — уточните вопросы у пользователя " +
        "и вызовите plan_task заново. Иначе покажите план пользователю и вызовите approve_plan. " +
        "Чтобы продолжить существующую сессию, передайте её id в session_id или в синониме session.",
      inputSchema: withSessionId(
        {
          task_text: z.string().min(1).describe("Текст задачи для Claude Code."),
          project_dir: z
            .string()
            .min(1)
            .describe("Абсолютный путь к каталогу проекта. Должен быть внутри белого списка сервера."),
          model: modelSchema,
          wait_seconds: waitSecondsSchema,
        },
        {
          required: false,
          description:
            "Продолжить существующую сессию Claude Code вместо новой. Можно передать и как session.",
        },
      ),
    },
    async (args) => {
      try {
        return await startTask({
          tool: "plan_task",
          taskText: args.task_text,
          projectDir: args.project_dir,
          sessionId: sessionIdOf(args),
          permissionMode: "plan",
          model: args.model,
          waitSeconds: args.wait_seconds ?? config.defaultWaitSeconds,
        });
      } catch (err) {
        const message = describeError(err);
        logger.write({
          event: err instanceof SessionBusyError ? "denied" : "error",
          tool: "plan_task",
          session_id: sessionIdOf(args) ?? null,
          message,
        });
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    "execute_task",
    {
      title: "Выполнить одобренный план",
      description:
        "Запускает Claude Code на выполнение задачи и возвращает итоговый отчёт: что сделано, " +
        "какие файлы изменены, какие были ошибки. ВАЖНО: выполняется только по одобренному плану. " +
        "session_id обязателен (его можно передать и как синоним session), и сессия должна быть " +
        "предварительно проведена через plan_task " +
        "и approve_plan — иначе вызов отклоняется. Запустить задачу «с нуля», минуя план, нельзя. " +
        "model можно указать отличную от той, которой строился план: одобрение привязано к тексту " +
        "плана и каталогу, а не к модели.",
      inputSchema: withSessionId(
        {
          task_text: z.string().min(1).describe("Текст задачи для Claude Code."),
          project_dir: z
            .string()
            .min(1)
            .describe("Абсолютный путь к каталогу проекта. Должен совпадать с тем, для которого строился план."),
          permission_mode: z
            .enum(PERMISSION_MODES)
            .optional()
            .describe(
              "acceptEdits — принимать правки файлов (по умолчанию). bypassPermissions — не спрашивать вообще, включая запуск команд.",
            ),
          model: modelSchema,
          wait_seconds: waitSecondsSchema,
        },
        {
          required: true,
          description:
            "Обязателен (либо он, либо синоним session). session_id одобренной сессии, полученный из plan_task.",
        },
      ),
    },
    async (args) => {
      // Схема уже потребовала одно из двух имён; ?? "" нужен только типам.
      const sessionId = sessionIdOf(args) ?? "";
      try {
        // Путь канонизируем до проверки допуска: одобрение привязано к
        // каталогу, для которого строился план.
        const cwd = validateProjectDir(args.project_dir, config.resolvedRoots);
        // До beginExecution: отказ по занятости не должен трогать одобрение.
        // Та же проверка повторится в startTask — уже вместе с бронью.
        assertSessionIdle(sessionId);
        sessions.beginExecution(sessionId, cwd);

        try {
          return await startTask({
            tool: "execute_task",
            taskText: args.task_text,
            projectDir: cwd,
            sessionId,
            permissionMode: args.permission_mode ?? "acceptEdits",
            model: args.model,
            waitSeconds: args.wait_seconds ?? config.defaultWaitSeconds,
          });
        } catch (err) {
          // Процесс не стартовал — возвращаем занятое одобрение, иначе сессия
          // осталась бы в состоянии executing навсегда.
          sessions.finishExecution(sessionId, false);
          throw err;
        }
      } catch (err) {
        const message = describeError(err);
        const denied =
          err instanceof ApprovalError ||
          err instanceof ProjectDirError ||
          err instanceof SessionBusyError;
        logger.write({
          event: denied ? "denied" : "error",
          tool: "execute_task",
          session_id: sessionId,
          session_param: sessionParamOf(args),
          project_dir: args.project_dir,
          message,
        });
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    "approve_plan",
    {
      title: "Одобрить план",
      description:
        "Явное согласие на выполнение плана: переводит сессию из состояния planned в approved, " +
        "после чего становится доступен execute_task. Вызывайте только после того, как план " +
        "из plan_task показан пользователю и получено согласие (либо план сверен с паспортом " +
        "проекта). plan_digest берётся из ответа plan_task и передаётся без изменений — так " +
        "нельзя одобрить план вслепую или по угаданному session_id. session_id можно передать " +
        "и как синоним session.",
      inputSchema: withSessionId(
        {
          plan_digest: z
            .string()
            .min(1)
            .describe("Значение plan_digest из ответа plan_task, без изменений."),
        },
        {
          required: true,
          description: "session_id из ответа plan_task (либо он, либо синоним session).",
        },
      ),
    },
    async (args) => {
      // Схема уже потребовала одно из двух имён; ?? "" нужен только типам.
      const sessionId = sessionIdOf(args) ?? "";
      try {
        const record = sessions.approve(sessionId, args.plan_digest);

        logger.write({
          event: "approve",
          session_id: record.sessionId,
          session_param: sessionParamOf(args),
          project_dir: record.projectDir,
          plan_digest: record.planDigest,
          session_state: record.state,
          planned_at: new Date(record.plannedAt).toISOString(),
        });

        const payload = {
          session_id: record.sessionId,
          session_state: record.state,
          project_dir: record.projectDir,
          plan_digest: record.planDigest,
          approved_at:
            record.approvedAt !== null ? new Date(record.approvedAt).toISOString() : null,
          next_step:
            `План одобрен. Вызовите execute_task с session_id "${record.sessionId}" ` +
            `и project_dir "${record.projectDir}".`,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload as unknown as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        const message = describeError(err);
        logger.write({
          event: err instanceof ApprovalError ? "denied" : "error",
          tool: "approve_plan",
          session_id: sessionId,
          session_param: sessionParamOf(args),
          message,
        });
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    "approve_permission_request",
    {
      title: "Решить запрос на разрешение",
      description:
        "Разрешает или запрещает конкретную операцию, которую дочерний Claude Code пытается " +
        "выполнить прямо сейчас (запуск команды, запись в файл). Запросы появляются в поле " +
        "permission_requests ответа get_task_status, пока задача выполняется. Вызывайте только " +
        "после того, как запрос показан пользователю и получено его согласие. request_id — " +
        "отпечаток самого вызова, его нельзя угадать, не увидев запрос в get_task_status. " +
        "Если вызов в этот момент удерживается мостом (permissionHoldSeconds), решение сразу " +
        "отвечает ему: после allow операция проходит с этой же попытки. Если удержание уже " +
        "истекло, после allow дочерний процесс повторит вызов сам; после deny — прекратит попытки.",
      inputSchema: {
        process_id: z
          .string()
          .min(1)
          .describe("Идентификатор задачи, выданный plan_task или execute_task."),
        request_id: z
          .string()
          .min(1)
          .describe("request_id из permission_requests в ответе get_task_status."),
        decision: z
          .enum(["allow", "deny"])
          .describe("allow — разрешить операцию, deny — отказать окончательно."),
        reason: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Комментарий оператора. При deny попадает в текст, который увидит дочерний Claude Code.",
          ),
      },
    },
    async (args) => {
      try {
        const job = jobs.get(args.process_id);
        if (!job) {
          return errorResult(
            `Задача ${args.process_id} не найдена. Реестр живёт только пока запущен сервер, ` +
              `а завершённые задачи хранятся ограниченное время. Список известных задач — list_tasks, ` +
              `история вызовов — в логе ${config.resolvedLogFile}.`,
          );
        }
        job.lastOperatorContactAt = Date.now();
        if (!job.bridge) {
          return errorResult(
            `Для задачи ${args.process_id} контроль разрешений не включён ` +
              `(hooksEnabled: false). Решать нечего.`,
          );
        }
        // Гонка: задача могла закончиться между отказом хука и одобрением.
        if (job.status !== "running") {
          return errorResult(
            `Задача ${args.process_id} уже завершена (${job.status}), решение применить не к чему.`,
          );
        }

        const record = job.bridge.resolve(args.request_id, args.decision, args.reason);

        logger.write({
          event: "permission",
          process_id: job.processId,
          project_dir: job.projectDir,
          request_id: record.requestId,
          tool_name: record.toolName,
          summary: record.summary,
          decision: record.decision,
          denied_count: record.deniedCount,
          reason: record.resolvedReason,
        });

        const payload = {
          process_id: job.processId,
          request_id: record.requestId,
          tool_name: record.toolName,
          summary: record.summary,
          decision: record.decision,
          denied_count: record.deniedCount,
          resolved_at:
            record.resolvedAt !== null ? new Date(record.resolvedAt).toISOString() : null,
          next_step:
            record.decision === "approved"
              ? `Решение записано. Удерживаемый вызов пропущен сразу, а если удержание уже истекло, ` +
                `дочерний Claude Code повторит вызов сам. Следите за ходом через ` +
                `get_task_status с process_id "${job.processId}".`
              : `Отказ записан. Дочерний Claude Code получит указание прекратить попытки и ` +
                `продолжить без этой операции. Следите за ходом через get_task_status.`,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload as unknown as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        const message = describeError(err);
        logger.write({
          event: err instanceof PermissionRequestError ? "denied" : "error",
          tool: "approve_permission_request",
          process_id: args.process_id,
          request_id: args.request_id,
          message,
        });
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    "get_task_status",
    {
      title: "Статус задачи",
      description:
        "Возвращает состояние ранее запущенной задачи по process_id. Пока status \"running\" — " +
        "задача идёт; когда становится done/failed/timeout/canceled, в ответе будет полный отчёт. " +
        "Даже у идущей задачи виден живой прогресс: progress содержит счётчики вызовов, " +
        "tools_used, last_tool_call, last_assistant_text, idle_seconds и recent_events, а " +
        "next_step называет обнаруженный паттерн — ждёт ли задача разрешения, зависла, " +
        "выполняет долгий инструмент или ходит по кругу. Стоимость (total_cost_usd) известна " +
        "только по завершении. " +
        "Если включён контроль разрешений, в поле permission_requests видны операции, которые " +
        "дочерний Claude Code пытается выполнить: те, что с decision \"pending\", ждут вашего " +
        "решения через approve_permission_request.",
      inputSchema: {
        process_id: z.string().min(1).describe("Идентификатор, выданный plan_task или execute_task."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(120)
          .optional()
          .describe(
            "Подождать завершения не дольше указанного времени. По умолчанию 0 — ответить сразу. " +
              "Ожидание прерывается досрочно, если появился новый запрос на разрешение, — " +
              "чтобы о нём не приходилось узнавать только со следующего опроса.",
          ),
      },
    },
    async (args) => {
      const job = jobs.get(args.process_id);
      if (!job) {
        return errorResult(
          `Задача ${args.process_id} не найдена. Реестр живёт только пока запущен сервер, ` +
            `а завершённые задачи хранятся ограниченное время. Список известных задач — list_tasks, ` +
            `история вызовов — в логе ${config.resolvedLogFile}.`,
        );
      }
      // Опрос — знак, что оператор на связи; пока он ждёт внутри wait_seconds —
      // тоже, поэтому отмечаем и до, и после ожидания.
      job.lastOperatorContactAt = Date.now();
      // Ждать завершения, но не пропустить запрос на разрешение: без этого
      // pending виден только со следующего опроса, уже после wait_seconds.
      const waitReason = await waitForJob(job, args.wait_seconds ?? 0, {
        wakeOnPendingPermission: true,
      });
      job.lastOperatorContactAt = Date.now();
      return toolResult(reportFor(job, waitReason));
    },
  );

  server.registerTool(
    "get_bridge_info",
    {
      title: "Версия и настройки моста",
      description:
        "Возвращает версию моста и Claude Code и действующие настройки, от которых зависит работа " +
        "агента: сколько может идти задача и сколько их можно запускать сразу, включён ли контроль " +
        "разрешений и какие команды проходят без одобрения (списки целиком — используйте эти " +
        "команды дословно, тогда они не потребуют одобрения), через сколько минут молчания мост " +
        "перестаёт ждать решений оператора, в каких каталогах можно работать и какого размера " +
        "файлы читать. Ничего не запускает и не меняет; вызывайте в начале работы и после " +
        "перезапуска сервера (server_started_at).",
      inputSchema: {},
    },
    async () => {
      const running = jobs.list().filter((j) => j.status === "running").length;
      const payload = {
        server: {
          name: "ccc-mcp",
          version: SERVER_VERSION,
          server_started_at: new Date(serverStartedAt).toISOString(),
          platform: process.platform,
          claude_version: runner.claudeVersion,
          default_model: runner.resolveModel(undefined),
          sandbox: { mode: config.sandbox, supported: runner.supportsSandbox },
        },
        tasks: {
          timeout_minutes: Math.round(config.timeoutMs / 60_000),
          default_wait_seconds: config.defaultWaitSeconds,
          max_wait_seconds: 120,
          max_concurrent: config.maxConcurrent,
          running_now: running,
          stream_events: config.streamEvents,
          session_retention_hours: Math.round(config.sessionRetentionMs / 3_600_000),
          job_retention_minutes: Math.round(config.jobRetentionMs / 60_000),
        },
        permissions: {
          hooks_enabled: config.hooksEnabled,
          ...(config.hooksEnabled
            ? {
                plan_hooked_tools: PLAN_SENSITIVE_TOOLS,
                execute_hooked_tools: config.sensitiveTools,
                hold_seconds: config.permissionHoldSeconds,
                retry_budget: config.retryBudget,
                max_pending_requests: config.maxPendingRequests,
                operator_absent_minutes: config.operatorAbsentMinutes,
                allow_wait_command: config.allowWaitCommand,
                plan_auto_approve_read_only: config.planAutoApproveReadOnly,
                execute_auto_approve_read_only: config.executeAutoApproveReadOnly,
                auto_approve_commands: config.autoApproveCommands,
                plan_auto_approve_commands: config.planAutoApproveCommands,
              }
            : {}),
          execute_permission_modes: PERMISSION_MODES,
        },
        files: {
          allowed_roots: config.resolvedRoots,
          max_file_bytes: config.maxFileBytes,
          max_list_entries: config.maxListEntries,
        },
        git: {
          available: git.error === null,
          version: git.version,
          max_diff_bytes: config.maxDiffBytes,
          timeout_seconds: Math.round(config.gitTimeoutMs / 1000),
        },
        next_step:
          (config.hooksEnabled
            ? `Опрашивайте идущие задачи чаще, чем раз в ${config.operatorAbsentMinutes} мин ` +
              `(operator_absent_minutes), иначе мост перестанет ждать ваших решений по разрешениям. `
            : "") +
          `Задача дольше ${Math.round(config.timeoutMs / 60_000)} мин будет остановлена по таймауту.`,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload as unknown as Record<string, unknown>,
        isError: false,
      };
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "Список задач",
      description:
        "Показывает идущие и недавние задачи plan_task/execute_task этого сервера, от новых к " +
        "старым: process_id, инструмент, статус, проект, session_id, время старта и выжимку текста " +
        "задачи. Нужен, когда process_id потерялся — например, ответ plan_task не дошёл из-за " +
        "обрыва соединения: прежде чем запускать задачу заново, проверьте здесь, не идёт ли она " +
        "уже, иначе две копии будут делать одну работу за двойные деньги. Реестр живёт в памяти: " +
        "после перезапуска сервера он пуст (server_started_at в ответе), а завершённые задачи " +
        "хранятся ограниченное время. Полный отчёт по задаче — get_task_status.",
      inputSchema: {
        project_dir: z
          .string()
          .min(1)
          .optional()
          .describe("Показать только задачи этого проекта. Должен быть внутри белого списка сервера."),
        status: z
          .enum(["running", "all"])
          .optional()
          .describe("running — только идущие; all (по умолчанию) — идущие и недавние завершённые."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Сколько задач вернуть, самые новые первыми. По умолчанию 20."),
      },
    },
    async (args) => {
      try {
        const dir =
          args.project_dir !== undefined
            ? validateProjectDir(args.project_dir, config.resolvedRoots)
            : null;
        const matching = jobs
          .list()
          .filter((j) => dir === null || j.projectDir === dir)
          .filter((j) => args.status !== "running" || j.status === "running");
        const limit = args.limit ?? 20;
        const now = Date.now();
        // Оператор смотрит на свои задачи — он на связи по всем идущим.
        for (const j of matching) if (j.status === "running") j.lastOperatorContactAt = now;
        const tasks = matching.slice(0, limit).map((j) => ({
          process_id: j.processId,
          tool: j.tool,
          status: j.status,
          ok: j.result?.ok ?? null,
          project_dir: j.projectDir,
          model: j.model,
          session_id:
            j.result?.sessionId ?? j.progress.snapshot().sessionId ?? j.requestedSessionId,
          started_at: new Date(j.startedAt).toISOString(),
          finished_at: j.finishedAt !== null ? new Date(j.finishedAt).toISOString() : null,
          last_operator_contact_at: new Date(j.lastOperatorContactAt).toISOString(),
          elapsed_seconds: Math.round(((j.finishedAt ?? now) - j.startedAt) / 1000),
          pending_permission_count: j.bridge?.pendingCount() ?? 0,
          task_preview: j.taskPreview,
        }));
        const running = tasks.filter((t) => t.status === "running");
        const payload = {
          server_started_at: new Date(serverStartedAt).toISOString(),
          count: tasks.length,
          total_matching: matching.length,
          tasks,
          next_step:
            running.length > 0
              ? `Идёт задач: ${running.length}. Подключитесь к нужной через get_task_status с её ` +
                `process_id (можно с wait_seconds), а не запускайте её заново.`
              : tasks.length > 0
                ? "Идущих задач нет. Отчёт по завершённой — get_task_status с её process_id."
                : "Задач нет: с момента server_started_at ничего не запускалось, либо завершённые " +
                  "уже вытеснены из памяти. Если ответ на запуск потерялся и задачи здесь нет, " +
                  "до сервера она не дошла — её можно запускать заново.",
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload as unknown as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    "cancel_task",
    {
      title: "Остановить задачу",
      description:
        "Принудительно останавливает выполняющуюся задачу вместе с дочерними процессами, " +
        "не дожидаясь таймаута. Отчёт Claude Code при этом не формируется (result_text " +
        "остаётся пустым), но накопленное состояние не теряется: hint перечисляет, что успело " +
        "произойти, progress хранит вызовы и последние события, а session_id позволяет " +
        "продолжить ту же сессию новым циклом plan_task → approve_plan → execute_task.",
      inputSchema: {
        process_id: z.string().min(1).describe("Идентификатор задачи, которую нужно остановить."),
      },
    },
    async (args) => {
      const job = jobs.get(args.process_id);
      if (!job) {
        return errorResult(`Задача ${args.process_id} не найдена.`);
      }
      job.lastOperatorContactAt = Date.now();
      if (job.status !== "running") {
        return toolResult(reportFor(job));
      }

      logger.write({
        event: "cancel",
        process_id: job.processId,
        tool: job.tool,
        project_dir: job.projectDir,
        pid: job.pid,
        // Сводка на момент отмены: лог должен объяснять, что именно потеряно, и
        // содержать session_id, по которому прогон ещё можно продолжить.
        ...progressLogFields(job.progress.snapshot()),
      });

      job.cancel();
      // Даём процессу закрыться, чтобы вернуть уже финальный статус.
      // Пробуждение на pending здесь не нужно: задача всё равно убита, и
      // просыпаться на её последний запрос разрешения незачем.
      const waitReason = await waitForJob(job, 10);
      return toolResult(reportFor(job, waitReason));
    },
  );

  // --- Файловые инструменты --------------------------------------------------
  //
  // Эти три тула сознательно вне протокола «план → одобрение → выполнение»:
  // они не спавнят claude, не создают Job, не занимают слот maxConcurrent и не
  // трогают SessionRegistry. Единственная граница — allowedRoots, ровно та же,
  // что у остальных тулов. Обоснование записи без одобрения: тот же результат
  // и так достижим через plan_task/execute_task, так что список разрешённых
  // имён файлов не дал бы защиты, только неудобство.

  const projectDirSchema = z
    .string()
    .min(1)
    .describe("Абсолютный путь к каталогу проекта. Должен быть внутри белого списка сервера.");

  const filePathSchema = z
    .string()
    .min(1)
    .max(1024)
    .describe(
      "Путь к файлу относительно project_dir, например \"CLAUDE.md\" или " +
        "\".claude/skills/foo/SKILL.md\". Абсолютные пути и выход за пределы project_dir " +
        "через \"..\" отклоняются.",
    );

  server.registerTool(
    "read_project_file",
    {
      title: "Прочитать файл проекта",
      description:
        "Читает текстовый файл проекта напрямую, без запуска Claude Code и без плана: файлы " +
        "не изменяются, токены не расходуются. Работает только внутри белого списка каталогов " +
        "сервера. Слишком большой файл (см. maxFileBytes) и бинарный файл возвращают ошибку, " +
        "частичное чтение не предусмотрено. Отсутствие файла — отдельная ошибка, с пустым файлом " +
        "её не спутать. Используйте вместо plan_task/execute_task, когда нужно просто показать " +
        "пользователю содержимое файла.",
      inputSchema: {
        project_dir: projectDirSchema,
        path: filePathSchema,
      },
    },
    async (args) => {
      try {
        const result = await readProjectFile({
          projectDir: args.project_dir,
          path: args.path,
          allowedRoots: config.resolvedRoots,
          maxBytes: config.maxFileBytes,
        });

        // Содержимое в лог не пишем — ни целиком, ни выжимкой: через этот тул
        // течёт произвольное тело файла, самое вероятное место для токенов и
        // паролей. Аудит обеспечивает связка path + bytes + sha256.
        logger.write({
          event: "file_read",
          project_dir: result.root,
          path: result.relativePath,
          bytes: result.bytes,
          sha256: result.sha256,
          lines: result.lines,
          mtime: result.mtime,
        });

        const payload = {
          project_dir: result.root,
          path: result.relativePath,
          content: result.content,
          bytes: result.bytes,
          mtime: result.mtime,
          encoding: result.encoding,
          has_bom: result.hasBom,
          eol: result.eol,
          lines: result.lines,
          sha256: result.sha256,
          next_step:
            "Файл прочитан. Чтобы записать изменения, вызовите write_project_file с тем же " +
            "project_dir и path, передав полное новое содержимое.",
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload as unknown as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        const message = describeError(err);
        const denied = err instanceof ProjectDirError || err instanceof ProjectFileError;
        logger.write({
          event: denied ? "denied" : "error",
          tool: "read_project_file",
          project_dir: args.project_dir,
          path: args.path,
          message,
        });
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    "write_project_file",
    {
      title: "Записать файл проекта",
      description:
        "Перезаписывает текстовый файл проекта ЦЕЛИКОМ содержимым из content — это не патч, " +
        "частичные правки не поддерживаются. Пишет напрямую, без запуска Claude Code и без плана. " +
        "Создаёт файл, если его не было, и недостающие промежуточные каталоги. Работает только " +
        "внутри белого списка каталогов сервера. В ответе возвращается previous — прежнее " +
        "содержимое, размер и sha256, чтобы вы могли показать пользователю, что изменилось. " +
        "Отменить запись нельзя: показывайте пользователю новую версию ДО вызова.",
      inputSchema: {
        project_dir: projectDirSchema,
        path: filePathSchema,
        content: z
          .string()
          .describe(
            "Полное новое содержимое файла. Файл перезаписывается целиком. Пустая строка — " +
              "легальное значение, она создаёт пустой файл.",
          ),
        include_previous: z
          .boolean()
          .optional()
          .describe(
            "Вернуть ли прежнее содержимое файла в previous.content. По умолчанию true; " +
              "передайте false, если старый текст у вас уже есть и не нужен в ответе.",
          ),
      },
    },
    async (args) => {
      try {
        const result = await writeProjectFile({
          projectDir: args.project_dir,
          path: args.path,
          content: args.content,
          includePrevious: args.include_previous ?? true,
          allowedRoots: config.resolvedRoots,
          maxBytes: config.maxFileBytes,
        });

        // Как и при чтении: ни нового, ни прежнего содержимого в логе нет.
        // Пара previous_sha256 → sha256 доказывает, какая версия какой сменилась.
        logger.write({
          event: "file_write",
          project_dir: result.root,
          path: result.relativePath,
          bytes: result.bytes,
          sha256: result.sha256,
          existed: result.existed,
          unchanged: result.unchanged,
          previous_bytes: result.previous?.bytes ?? null,
          previous_sha256: result.previous?.sha256 ?? null,
          created_dirs: result.createdDirs,
        });

        const payload = {
          project_dir: result.root,
          path: result.relativePath,
          bytes: result.bytes,
          sha256: result.sha256,
          existed: result.existed,
          created: !result.existed,
          unchanged: result.unchanged,
          created_dirs: result.createdDirs,
          mtime: result.mtime,
          previous:
            result.previous === null
              ? null
              : {
                  bytes: result.previous.bytes,
                  sha256: result.previous.sha256,
                  mtime: result.previous.mtime,
                  lines: result.previous.lines,
                  content: result.previous.content,
                  omitted_reason: result.previous.omittedReason,
                },
          next_step: result.existed
            ? result.unchanged
              ? `Файл ${result.relativePath} перезаписан, но содержимое не изменилось — ` +
                `сообщите пользователю, что правка ничего не поменяла.`
              : `Файл ${result.relativePath} перезаписан. Покажите пользователю, что изменилось, ` +
                `сравнив previous.content с тем, что вы записали.`
            : `Создан новый файл ${result.relativePath}. Сообщите об этом пользователю` +
              (result.createdDirs.length > 0
                ? `, вместе с созданными каталогами: ${result.createdDirs.join(", ")}.`
                : `.`),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload as unknown as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        const message = describeError(err);
        const denied = err instanceof ProjectDirError || err instanceof ProjectFileError;
        logger.write({
          event: denied ? "denied" : "error",
          tool: "write_project_file",
          project_dir: args.project_dir,
          path: args.path,
          bytes: Buffer.byteLength(args.content, "utf8"),
          message,
        });
        return errorResult(message);
      }
    },
  );

  server.registerTool(
    "list_project_files",
    {
      title: "Показать файлы проекта",
      description:
        "Возвращает плоский список файлов и каталогов проекта с размером и mtime — напрямую, без " +
        "запуска Claude Code и без плана. Вызывайте ПЕРЕД read_project_file/write_project_file, " +
        "когда точный относительный путь неизвестен. Пути в ответе годятся для этих тулов без " +
        "правки. По умолчанию обходит дерево рекурсивно и пропускает мусор: .git (всегда), " +
        "node_modules, dist, build, target, __pycache__, .venv, venv, .next, .idea, .DS_Store, " +
        "плюс всё из .gitignore проекта. Для поиска по имени есть name_contains и extensions; " +
        "полноценный glob не поддерживается — такая разведка по проекту делается через " +
        "plan_task/execute_task. Слишком большое дерево не ошибка: придёт частичный список с " +
        "truncated: true.",
      inputSchema: {
        project_dir: projectDirSchema,
        path: z
          .string()
          .min(1)
          .max(1024)
          .optional()
          .describe(
            "Каталог или файл относительно project_dir, например \"src\" или \".claude/skills\". " +
              "По умолчанию корень project_dir. Указание подкаталога — главный способ сузить " +
              "слишком большой листинг. Явно запрошенный путь показывается даже если он " +
              "попадает под правила игнора.",
          ),
        recursive: z
          .boolean()
          .optional()
          .describe(
            "Обходить ли вложенные каталоги. По умолчанию true — иначе файл, о котором известно " +
              "только имя, не найти. false даёт дешёвый взгляд на один уровень.",
          ),
        name_contains: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            "Подстрока в ИМЕНИ файла (последний сегмент пути), регистр не важен. Например " +
              "\"claude\" находит CLAUDE.md. По пути целиком не ищет — для этого есть path.",
          ),
        extensions: z
          .array(z.string().min(1).max(32))
          .max(20)
          .optional()
          .describe(
            "Расширения файлов, например [\"md\", \"ts\"]. Точка в начале не обязательна, " +
              "регистр не важен. Файлы без расширения под такой фильтр не подпадают.",
          ),
        ignore: z
          .array(z.string().min(1).max(256))
          .max(50)
          .optional()
          .describe(
            "Дополнительные паттерны игнора поверх дефолтных и .gitignore, например " +
              "[\"docs\", \"*.snap\"]. Синтаксис — подмножество .gitignore: *, ?, **, " +
              "завершающий / для каталогов. Отрицания (!) не поддерживаются и отклоняются.",
          ),
        use_default_ignores: z
          .boolean()
          .optional()
          .describe(
            "Применять ли встроенный список (node_modules, dist, …). По умолчанию true. " +
              "false показывает и его содержимое; .git исключён всегда независимо от этого флага.",
          ),
        use_gitignore: z
          .boolean()
          .optional()
          .describe(
            "Учитывать ли .gitignore из корня project_dir. По умолчанию true. Передайте false, " +
              "если нужный файл скрыт правилом игнора.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Предел числа записей. По умолчанию и максимум — maxListEntries конфига; большее " +
              "значение зажимается. Достижение лимита даёт truncated: true, а не ошибку.",
          ),
      },
    },
    async (args) => {
      const requestedPath = args.path ?? ".";
      try {
        // Отрицания в пользовательских паттернах отклоняем явно: их автор —
        // сам вызывающий, и молча проглотить его правило хуже, чем отказать.
        // В .gitignore проекта они, наоборот, только считаются: тот файл писал
        // не вызывающий, и ронять из-за него листинг незачем.
        const badNegation = (args.ignore ?? []).find((p) => p.trim().startsWith("!"));
        if (badNegation !== undefined) {
          throw new FileOpError(
            `паттерн-отрицание в ignore не поддерживается: ${badNegation}. ` +
              `Перечислите то, что нужно скрыть, либо сузьте область параметром path.`,
          );
        }

        const limit = Math.min(args.limit ?? config.maxListEntries, config.maxListEntries);
        const result = await listProjectFiles({
          projectDir: args.project_dir,
          path: requestedPath,
          allowedRoots: config.resolvedRoots,
          recursive: args.recursive ?? true,
          nameContains: args.name_contains ?? null,
          extensions: args.extensions ? normalizeExtensions(args.extensions) : null,
          ignore: args.ignore ?? [],
          useDefaultIgnores: args.use_default_ignores ?? true,
          useGitignore: args.use_gitignore ?? true,
          limit,
          // Фильтр считает выданные записи, а не просмотренные, так что поиск
          // по огромному дереву мог бы вернуть три строки и молотить минуту.
          scanLimit: config.maxListEntries * 50,
        });

        // Сами пути в лог не пишем: принцип «не логировать лишнее» тот же, что
        // у file_read/file_write, а полный листинг репозитория на каждый вызов
        // раздул бы JSONL без пользы для аудита. Агрегатов и параметров
        // запроса, по которым листинг воспроизводится, достаточно.
        logger.write({
          event: "file_list",
          project_dir: result.root,
          path: result.relativePath,
          recursive: args.recursive ?? true,
          count: result.entries.length,
          file_count: result.fileCount,
          dir_count: result.dirCount,
          truncated: result.truncated,
          truncated_reason: result.truncatedReason,
          scanned: result.scanned,
          unreadable: result.unreadable,
          name_contains: args.name_contains ?? null,
          extensions: args.extensions ?? null,
          ignore_count: (args.ignore ?? []).length,
          use_default_ignores: args.use_default_ignores ?? true,
          use_gitignore: args.use_gitignore ?? true,
        });

        const narrowHint =
          `Сузьте область: path на конкретный подкаталог, name_contains, extensions ` +
          `или recursive: false.`;
        const negationHint =
          result.gitignoreNegationsIgnored > 0
            ? ` В .gitignore пропущено правил-отрицаний: ${result.gitignoreNegationsIgnored} — ` +
              `если нужный файл не виден, повторите с use_gitignore: false.`
            : "";

        let nextStep: string;
        if (result.truncated) {
          nextStep =
            result.truncatedReason === "scanned"
              ? `Обход остановлен: просмотрено ${result.scanned} записей, а под фильтр попало ` +
                `лишь ${result.entries.length}. ${narrowHint}`
              : `Показаны первые ${result.entries.length} записей, дерево больше. ${narrowHint}`;
        } else if (result.entries.length === 0) {
          nextStep =
            `Ничего не найдено. Проверьте фильтр и path; если файл может быть скрыт правилом ` +
            `игнора, повторите с use_gitignore: false или use_default_ignores: false.` +
            negationHint;
        } else {
          nextStep =
            `Чтобы прочитать файл, вызовите read_project_file с тем же project_dir и path из ` +
            `entries — путь подставляется без изменений.` + negationHint;
        }

        const payload = {
          project_dir: result.root,
          path: result.relativePath,
          recursive: args.recursive ?? true,
          entries: result.entries.map((e) => ({
            path: e.path,
            is_dir: e.isDir,
            is_symlink: e.isSymlink,
            size: e.size,
            mtime: e.mtime,
          })),
          count: result.entries.length,
          file_count: result.fileCount,
          dir_count: result.dirCount,
          truncated: result.truncated,
          truncated_reason: result.truncatedReason,
          limit,
          scanned: result.scanned,
          unreadable: result.unreadable,
          ignore_sources: {
            default: args.use_default_ignores ?? true,
            gitignore: result.gitignoreFound,
            custom: (args.ignore ?? []).length,
          },
          gitignore_negations_ignored: result.gitignoreNegationsIgnored,
          filtered: result.filtered,
          next_step: nextStep,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload as unknown as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        const message = describeError(err);
        const denied = err instanceof ProjectDirError || err instanceof ProjectFileError;
        logger.write({
          event: denied ? "denied" : "error",
          tool: "list_project_files",
          project_dir: args.project_dir,
          path: requestedPath,
          message,
        });
        return errorResult(message);
      }
    },
  );

  // --- Git-инструмент --------------------------------------------------------
  //
  // Как и файловые тулы, вне протокола «план → одобрение → выполнение»: не
  // спавнит claude, не создаёт Job, не занимает слот maxConcurrent. Операция —
  // строковый enum, а не команда: push, reset, rebase и прочее не «запрещены
  // флагом», их просто нет среди вариантов, и попытка передать такую операцию
  // отсеивается обычной валидацией схемы.

  server.registerTool(
    "run_git",
    {
      title: "Git-операция напрямую",
      description:
        "Выполняет одну из фиксированного набора git-операций прямо в project_dir, без запуска " +
        "Claude Code и без плана: токены не расходуются, время не тратится. Берите его вместо " +
        "plan_task/execute_task для механической работы с git — посмотреть статус, закоммитить " +
        "уже согласованные правки, создать или сменить ветку. project_dir обязан быть корнем " +
        "репозитория (каталогом, в котором лежит .git) и находиться внутри белого списка сервера. " +
        "Доступны только операции из списка operation: сетевых (push, pull, fetch) и разрушительных " +
        "(reset, rebase, merge, clean, rm) среди них нет вовсе. Если git отработал с ошибкой — " +
        "например, коммитить нечего или рабочее дерево мешает переключению, — это не ошибка вызова: " +
        "в ответе придут success: false, git_exit_code и git_stderr с родным сообщением git, " +
        "которое и надо показать пользователю.",
      inputSchema: {
        project_dir: projectDirSchema,
        operation: z
          .enum(GIT_OPERATIONS)
          .describe(
            "Что сделать. status — состояние рабочего дерева; log — история коммитов; " +
              "diff — изменения текстом; branch_list — список локальных веток; " +
              "branch_create — создать ветку; checkout_branch — перейти на существующую ветку; " +
              "add_commit — проиндексировать перечисленные пути и закоммитить. " +
              "Каждая операция принимает свой набор параметров: лишний параметр — ошибка.",
          ),
        path: z
          .string()
          .min(1)
          .max(1024)
          .optional()
          .describe(
            "Только для status, log и diff: ограничить операцию одним файлом или каталогом. " +
              "Путь относительно project_dir; абсолютные пути и выход через \"..\" отклоняются.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Только для log: сколько последних коммитов вернуть. По умолчанию 10."),
        staged: z
          .boolean()
          .optional()
          .describe(
            "Только для diff: показать проиндексированные изменения (git diff --cached) " +
              "вместо изменений в рабочем дереве. По умолчанию false.",
          ),
        stat: z
          .boolean()
          .optional()
          .describe(
            "Только для diff: вернуть сводку по файлам вместо полного патча. Полезно, когда " +
              "пришло truncated: true и дифф не помещается целиком.",
          ),
        name: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe(
            "Имя ветки: для branch_create — создаваемой, для checkout_branch — существующей. " +
              "Разрешены латинские буквы, цифры, точка, дефис, подчёркивание и слэш.",
          ),
        from: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe(
            "Только для branch_create: имя ветки-источника. Без него новая ветка растёт " +
              "от текущего HEAD.",
          ),
        checkout: z
          .boolean()
          .optional()
          .describe(
            "Только для branch_create: сразу перейти на созданную ветку (git checkout -b). " +
              "По умолчанию false — ветка создаётся, текущая не меняется.",
          ),
        paths: z
          .array(z.string().min(1).max(1024))
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Только для add_commit: явный список путей относительно project_dir, которые нужно " +
              "проиндексировать. Значение \".\" допустимо и означает весь репозиторий. " +
              "Учтите: git коммитит весь индекс, поэтому уже застейдженные ранее изменения тоже " +
              "войдут в коммит — фактический состав придёт в ответе полем files.",
          ),
        message: z
          .string()
          .min(1)
          .max(32768)
          .optional()
          .describe(
            "Только для add_commit: полный текст сообщения коммита. Передаётся git через stdin, " +
              "поэтому кавычки, $( ), обратные кавычки и ; внутри него безопасны и сохраняются " +
              "как есть.",
          ),
      },
    },
    async (args) => {
      try {
        const result = await runGitOperation({
          operation: args.operation,
          projectDir: args.project_dir,
          allowedRoots: config.resolvedRoots,
          gitBin: config.gitBin,
          maxOutputBytes: config.maxDiffBytes,
          timeoutMs: config.gitTimeoutMs,
          path: args.path,
          limit: args.limit,
          staged: args.staged,
          stat: args.stat,
          name: args.name,
          from: args.from,
          checkout: args.checkout,
          paths: args.paths,
          message: args.message,
        });

        // Ни содержимого диффа, ни путей из status/log/add_commit в логе нет —
        // та же граница, что у file_list, который не пишет список путей.
        // Сообщение коммита — исключение: это авторская сводка намерения, которая
        // и так вот-вот станет публичной в истории репозитория, и в аудите
        // «что именно закоммитил мост» это самое полезное поле. Пишем выжимкой,
        // тем же механизмом, что и task_preview.
        logger.write({
          event: "git_op",
          operation: result.operation,
          project_dir: result.root,
          success: result.success,
          git_exit_code: result.gitExitCode,
          duration_ms: result.durationMs,
          ...result.logFields,
          ...(args.operation === "add_commit" && args.message !== undefined
            ? { message_preview: preview(args.message, config.logTaskTextChars) }
            : {}),
        });

        const payload = {
          project_dir: result.root,
          operation: result.operation,
          success: result.success,
          git_exit_code: result.gitExitCode,
          duration_ms: result.durationMs,
          ...result.data,
          ...(result.gitStderr.length > 0 ? { git_stderr: result.gitStderr } : {}),
          // stdout отдаём только при неуспехе: при успехе он уже разобран в поля
          // выше, и дублировать его значило бы удваивать ответ.
          ...(!result.success && result.gitStdout.length > 0
            ? { git_stdout: result.gitStdout }
            : {}),
          next_step: result.nextStep,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload as unknown as Record<string, unknown>,
          isError: false,
        };
      } catch (err) {
        const message = describeError(err);
        const denied = err instanceof ProjectDirError || err instanceof ProjectFileError;
        logger.write({
          event: denied ? "denied" : "error",
          tool: "run_git",
          operation: args.operation,
          project_dir: args.project_dir,
          message,
        });
        return errorResult(message);
      }
    },
  );

  const shutdown = (): void => {
    jobs.cancelAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.stderr("сервер запущен, транспорт stdio");
}

main().catch((err: unknown) => {
  process.stderr.write(`[ccc-mcp] фатальная ошибка: ${String(err)}\n`);
  process.exit(1);
});

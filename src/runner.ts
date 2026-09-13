import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { extname } from "node:path";
import type { Config } from "./config.js";
import { scrubEnv } from "./env.js";
import type { Logger } from "./logger.js";
import {
  MAX_STDERR_TAIL,
  MAX_STDOUT_TAIL,
  NdjsonSplitter,
  type BadLineReason,
  type StreamEvent,
} from "./stream.js";

const isWindows = process.platform === "win32";

/** Опознавательные поля для записей stream_warn. */
export interface StreamWarnContext {
  processId: string | null;
  tool: string | null;
  sessionId: string | null;
}

export interface RunOptions {
  args: string[];
  cwd: string;
  timeoutMs: number;
  /**
   * Событие потока NDJSON. Само присутствие колбэка включает стрим-режим
   * раннера: stdout больше не копится целиком, наружу уходит только последняя
   * строка result.
   *
   * Колбэк, а не EventEmitter и не async-итератор: он передаётся внутрь run() и
   * ставится до spawn(), поэтому окна, в котором события теряются, нет вовсе.
   */
  onEvent?: (ev: StreamEvent) => void;
  /**
   * Непарсящаяся или слишком длинная строка потока.
   *
   * Отдельным колбэком, а не полем события: счётчик плохих строк — единственное
   * окно в смену формата дочернего CLI, и терять его в общем потоке нельзя.
   */
  onBadLine?: (chars: number, reason: BadLineReason) => void;
  /**
   * Откуда взять опознавательные поля для записей stream_warn.
   *
   * Замыкание, а не значения: process_id появляется только после spawn (Job
   * создаётся уже по результату run()), а session_id — из строки init, то есть
   * во время работы. Единственный источник истины про session_id остаётся
   * JobProgress: своего раннер не ведёт, чтобы не появилось второе значение,
   * способное разойтись с отчётом.
   *
   * Резолвится не чаще одного раза на класс сбоя, то есть максимум трижды на
   * процесс, — цена снимка здесь не имеет значения.
   */
  warnContext?: () => StreamWarnContext;
}

export interface RunHandle {
  /** Разрешается, когда процесс завершился любым способом. */
  done: Promise<RunOutcome>;
  /** Принудительно останавливает процесс вместе с потомками. */
  cancel: () => void;
  pid: number | undefined;
}

export interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Процесс убит нами: по таймауту или через cancel. */
  killed: boolean;
  timedOut: boolean;
  startedAt: number;
  finishedAt: number;
}

export class SpawnError extends Error {}

/**
 * Дописывает кусок в ограниченный хвост.
 *
 * Подрезка амортизированная — иначе каждый чанк порождал бы новый slice и
 * получилось бы O(n²) на длинном выводе. Точная подрезка до cap делается один
 * раз, при формировании результата.
 */
function appendTail(current: string, part: string, cap: number): string {
  const next = current + part;
  return next.length > 2 * cap ? next.slice(-cap) : next;
}

/** Точная подрезка хвоста — один раз, при формировании результата. */
function trimTail(text: string, cap: number): string {
  return text.length > cap ? text.slice(-cap) : text;
}

/**
 * Настройки для --settings: PreToolUse-хук на каждый чувствительный инструмент.
 *
 * Отдельная запись на имя, а не regex и не "*": про regex в matcher ничего не
 * подтверждено, а "*" гнал бы через мост вообще все вызовы, включая Read/Grep,
 * — лишний трафик и лишний риск случайного отказа на безобидной операции.
 */
export function buildHookSettings(
  hookUrl: string,
  tools: string[],
): { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; url: string }> }> } } {
  return {
    hooks: {
      PreToolUse: tools.map((matcher) => ({
        matcher,
        hooks: [{ type: "http", url: hookUrl }],
      })),
    },
  };
}

/**
 * Убивает процесс вместе с деревом потомков.
 *
 * На Windows child.kill() не трогает внуков, а claude порождает их — поэтому
 * taskkill /T. На остальных платформах — мягкий SIGTERM, затем SIGKILL.
 */
function killTree(child: ChildProcess, logger: Logger): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (isWindows) {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (err) {
      logger.stderr(`taskkill не сработал для pid ${pid}: ${String(err)}`);
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, 5000).unref();
}

export class ClaudeRunner {
  private sandboxSupported = false;
  private version = "unknown";
  private running = 0;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  get concurrency(): number {
    return this.running;
  }

  get supportsSandbox(): boolean {
    return this.sandboxSupported;
  }

  get claudeVersion(): string {
    return this.version;
  }

  /**
   * Разовая проверка CLI на старте: версия и наличие --sandbox.
   *
   * Флага --sandbox нет ни в 2.1.177, ни в 2.1.268 — детектим его, чтобы мост
   * начал передавать флаг сам, если он появится в будущих версиях.
   */
  probe(): void {
    const { env } = scrubEnv(process.env, this.config.passEnv);
    const bin = this.config.claudeBin;

    // На Windows .cmd/.bat требуют shell:true (Node 20+), а shell — это риск
    // инъекции через текст задачи. Такой бинарь не принимаем.
    const ext = extname(bin).toLowerCase();
    if (ext === ".cmd" || ext === ".bat") {
      throw new SpawnError(
        `claudeBin указывает на ${ext}-обёртку (${bin}). Такие файлы требуют запуска ` +
          `через shell, что небезопасно. Укажите путь к claude.exe, например ` +
          `C:\\Users\\<имя>\\.local\\bin\\claude.exe`,
      );
    }

    const version = spawnSync(bin, ["--version"], {
      env,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      shell: false,
    });

    if (version.error) {
      throw new SpawnError(
        `не удалось запустить "${bin}": ${version.error.message}. ` +
          `Проверьте, что Claude Code установлен и доступен в PATH, либо задайте claudeBin в конфиге.`,
      );
    }
    this.version = (version.stdout || "").trim() || "unknown";

    const help = spawnSync(bin, ["--help"], {
      env,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      shell: false,
    });
    const helpText = `${help.stdout ?? ""}`;
    // Ищем именно строку опции, а не упоминание слова «sandbox» в описании
    // других флагов (--dangerously-skip-permissions такое содержит).
    this.sandboxSupported = /^\s+--sandbox\b/m.test(helpText);

    this.logger.write({
      event: "startup",
      claude_version: this.version,
      claude_bin: bin,
      model: this.config.model ?? "(по умолчанию CLI)",
      sandbox_supported: this.sandboxSupported,
      sandbox_mode: this.config.sandbox,
      allowed_roots: this.config.resolvedRoots,
      max_concurrent: this.config.maxConcurrent,
      timeout_ms: this.config.timeoutMs,
      config_source: this.config.source,
    });
  }

  /**
   * Собирает аргументы запуска claude.
   *
   * Единственное место, где формируется командная строка, — чтобы запрет
   * AskUserQuestion и системная инструкция не могли потеряться на одном из
   * путей вызова.
   */
  buildTaskArgs(params: {
    permissionMode: string;
    taskText: string;
    sessionId?: string | undefined;
    appendSystemPrompt: string;
    /** Модель для этого вызова. Перекрывает config.model. */
    model?: string | undefined;
    /** URL HTTP-хука моста разрешений. Без него --settings не передаётся вовсе. */
    hookUrl?: string | undefined;
    /**
     * Просить у CLI поток событий вместо одного итогового JSON.
     *
     * Обязательный параметр, а не значение из конфига: командная строка должна
     * читаться целиком по месту вызова, и при добавлении нового пути запуска
     * компилятор обязан потребовать явного решения.
     *
     * Форка по инструменту нет: plan_task и execute_task идут одной веткой.
     * Признать поток слишком рискованным для одного из них значило бы завести
     * два пути с расходящимися входом парсера, полями лога и формой отчёта.
     */
    stream: boolean;
  }): string[] {
    const args = [
      "--permission-mode",
      params.permissionMode,
      // Интерактивный диалог в headless-режиме всё равно не показывается:
      // CLI резолвит вызов пустым ответом, и модель молча продолжает на своих
      // предположениях. Запрещаем инструмент, чтобы такой путь был закрыт.
      "--disallowedTools",
      "AskUserQuestion",
      "--append-system-prompt",
      params.appendSystemPrompt,
      "-p",
      params.taskText,
      // --include-hook-events сознательно отсутствует: мост САМ является
      // обработчиком PreToolUse-хука и узнаёт о срабатывании синхронно, раньше
      // и точнее, чем сообщило бы событие потока. Второй источник истины о
      // состоянии разрешений дал бы два несогласных счётчика вместо одного.
      //
      // --include-partial-messages отсутствует так же сознательно: частичные чанки
      // ассистентского текста и thinking раздули бы поток на порядок, а снимку не
      // дали бы ничего. Их type "stream_event" в ingest не разобран и уходит в
      // default-ветку, где только копится в unknownTypes и вытесняет из кольца
      // recent_events (20 записей) настоящие вызовы инструментов. Нужная
      // гранулярность и так есть: пульс system/thinking_tokens идёт раз в сотни
      // миллисекунд.
      ...(params.stream
        ? // --verbose обязателен: без него CLI отвергает stream-json жёсткой
          // ошибкой запуска («requires --verbose»), а не тихой деградацией.
          ["--output-format", "stream-json", "--verbose"]
        : ["--output-format", "json"]),
    ];

    const model = this.resolveModel(params.model);
    if (model) args.push("--model", model);
    if (params.sessionId) args.push("--resume", params.sessionId);
    if (this.shouldPassSandbox()) args.push("--sandbox");
    if (params.hookUrl) {
      args.push(
        "--settings",
        JSON.stringify(buildHookSettings(params.hookUrl, this.config.sensitiveTools)),
      );
    }

    return args;
  }

  /**
   * Какая модель реально уйдёт в --model. null — флаг не добавляем вовсе.
   *
   * Модель вызова перекрывает конфиг, конфиг перекрывает умолчание CLI. Вынесено
   * отдельно, чтобы отчёт и лог показывали ровно то значение, что ушло в argv.
   */
  resolveModel(requested?: string | undefined): string | null {
    return requested ?? this.config.model ?? null;
  }

  /** Нужно ли добавлять --sandbox с учётом конфига и реальной поддержки CLI. */
  shouldPassSandbox(): boolean {
    if (this.config.sandbox === "off") return false;
    if (this.config.sandbox === "on") return true;
    return this.sandboxSupported;
  }

  run(options: RunOptions): RunHandle {
    if (this.running >= this.config.maxConcurrent) {
      throw new SpawnError(
        `достигнут предел одновременных задач (${this.config.maxConcurrent}). ` +
          `Дождитесь завершения текущих через get_task_status или остановите ненужную через cancel_task.`,
      );
    }

    const { env } = scrubEnv(process.env, this.config.passEnv);
    const startedAt = Date.now();

    const child = spawn(this.config.claudeBin, options.args, {
      cwd: options.cwd,
      env,
      shell: false, // текст задачи идёт отдельным элементом argv — инъекция невозможна
      windowsHide: true,
      detached: !isWindows, // своя группа процессов, чтобы убить всё дерево
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.running++;

    /** Весь stdout — только в буферном режиме (onEvent не задан). */
    let stdout = "";
    /** Последняя строка с type:"result" — единственное, что нужно парсеру. */
    let lastResultLine = "";
    /** Хвост stdout для диагностики, когда строки result не случилось. */
    let stdoutTail = "";
    let stderr = "";
    let killed = false;
    let timedOut = false;
    let settled = false;
    /** Потребитель событий уже падал — второй раз в лог не пишем. */
    let consumerFailed = false;
    /** По каким классам сбоя stream_warn уже писали: одна запись на класс. */
    const warnedReasons = new Set<string>();
    /** Разобранные события и плохие строки: нужны записи no_result_line. */
    let eventsSeen = 0;
    let badLines = 0;
    let oversizeLines = 0;

    const consumer = options.onEvent;
    const badLineConsumer = options.onBadLine;

    /**
     * Одна запись stream_warn на класс сбоя за весь процесс.
     *
     * Ограничение по классу, а не по процессу: «непарсящаяся строка» (дрейф
     * формата) и «строка сверх предела» (гигантский tool_result) — разные
     * диагнозы с разными действиями, и JobProgress тоже считает их раздельно.
     * Количество дублировать не нужно: его несёт progress.bad_lines.
     *
     * Ничего не бросает наружу: зовётся из обработчика 'data' и из finish(), а
     * там исключение стало бы uncaught и унесло весь MCP-сервер. Флаг класса
     * ставится до записи, поэтому упавшая запись не превращается в поток попыток.
     */
    const warnStream = (reason: string, fields: Record<string, unknown>): void => {
      if (warnedReasons.has(reason)) return;
      warnedReasons.add(reason);
      try {
        const ctx = options.warnContext?.();
        this.logger.write({
          event: "stream_warn",
          reason,
          process_id: ctx?.processId ?? null,
          tool: ctx?.tool ?? null,
          project_dir: options.cwd,
          session_id: ctx?.sessionId ?? null,
          ...fields,
        });
      } catch (err) {
        this.logger.stderr(`не удалось записать предупреждение о потоке: ${String(err)}`);
      }
    };

    const splitter =
      consumer === undefined
        ? null
        : new NdjsonSplitter({
            onEvent: (ev) => {
              // Побеждает последняя строка result: у длинных прогонов пар
              // init → result внутри одного процесса бывает несколько, и
              // семантика та же, что у обратного сканирования в парсере.
              //
              // Хранится сериализованный объект, а не исходная строка:
              // StreamEvent сырого текста не несёт, а парсеру JSON-эквивалент
              // точен — он делает над ней JSON.parse и читает поля по имени.
              if (ev.type === "result") lastResultLine = JSON.stringify(ev.data);
              eventsSeen++;
              // Исключение из колбэка нельзя пробросить: из обработчика 'data'
              // оно станет uncaught и унесёт весь MCP-сервер.
              try {
                consumer(ev);
              } catch (err) {
                if (!consumerFailed) {
                  consumerFailed = true;
                  this.logger.stderr(`обработчик событий потока бросил исключение: ${String(err)}`);
                }
              }
            },
            onBadLine: (chars, reason) => {
              if (reason === "too_long") oversizeLines++;
              else badLines++;
              // Содержимого строки в записи нет даже частично: сплиттер его не
              // отдаёт вовсе, а для опознания дрейфа формата достаточно длины и
              // причины. Плохая строка — самое вероятное место для чужих данных.
              warnStream(reason, {
                line_chars: chars,
                bad_lines: badLines,
                oversize_lines: oversizeLines,
              });
              try {
                badLineConsumer?.(chars, reason);
              } catch (err) {
                if (!consumerFailed) {
                  consumerFailed = true;
                  this.logger.stderr(`обработчик событий потока бросил исключение: ${String(err)}`);
                }
              }
            },
          });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (splitter === null) {
        stdout += chunk;
        return;
      }
      stdoutTail = appendTail(stdoutTail, chunk, MAX_STDOUT_TAIL);
      splitter.push(chunk);
    });
    // Хвост без перевода строки: 'end' и 'close' между собой не упорядочены,
    // поэтому flush есть и здесь, и защитно в finish(). Метод идемпотентен.
    child.stdout?.on("end", () => splitter?.flush());
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendTail(stderr, chunk, MAX_STDERR_TAIL);
    });

    // Без этих обработчиков ошибка потока становится uncaught exception и
    // уносит весь MCP-сервер. Убийство процесса посреди чтения — ровно то
    // место, где вылезают EPIPE и ECONNRESET, а после перехода на поток
    // отмена задач станет обычным делом.
    child.stdout?.on("error", (err: Error) => {
      stderr = appendTail(stderr, `\n[stdout error] ${err.message}`, MAX_STDERR_TAIL);
    });
    child.stderr?.on("error", (err: Error) => {
      stderr = appendTail(stderr, `\n[stderr error] ${err.message}`, MAX_STDERR_TAIL);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      killTree(child, this.logger);
    }, options.timeoutMs);
    timer.unref();

    const done = new Promise<RunOutcome>((resolve) => {
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running--;

        // Сначала добираем хвост: последняя строка могла прийти без перевода
        // строки, и именно она бывает строкой result.
        try {
          splitter?.flush();
        } catch (err) {
          this.logger.stderr(`не удалось дочитать хвост потока: ${String(err)}`);
        }

        // Итоговой строки result нет, хотя поток что-то выдал: это либо смена
        // формата, либо обрыв. Пишем один раз и вместе со счётчиками плохих
        // строк — комбинация «плохие строки были И result не пришёл» и есть
        // прямой признак дрейфа формата.
        //
        // Два исключения, чтобы событие означало именно дрейф, а не норму:
        // killed (cancel_task и таймаут) — там отсутствие result ожидаемо, и
        // запись на каждую отмену залила бы лог шумом ровно того класса, от
        // которого это событие должно предупреждать; и полная тишина — CLI, не
        // сказавший ничего, это провал авторизации, модели или спавна, уже
        // видимый по stderr в записи finish и по паттерну no_progress.
        if (
          splitter !== null &&
          lastResultLine === "" &&
          !killed &&
          (eventsSeen > 0 || badLines > 0 || oversizeLines > 0)
        ) {
          warnStream("no_result_line", {
            bad_lines: badLines,
            oversize_lines: oversizeLines,
            events: eventsSeen,
            exit_code: exitCode,
            stdout_tail_chars: stdoutTail.length,
          });
        }

        resolve({
          stdout:
            splitter === null
              ? stdout
              : // Парсеру достаётся строка result — тогда срабатывает быстрая
                // ветка extractJson. Если её не случилось (отмена, таймаут,
                // сломанный формат), уходит хвост: ровно то, что и сегодня
                // попадает в диагностику parse_error.
                lastResultLine || trimTail(stdoutTail, MAX_STDOUT_TAIL),
          stderr: trimTail(stderr, MAX_STDERR_TAIL),
          exitCode,
          signal,
          killed,
          timedOut,
          startedAt,
          finishedAt: Date.now(),
        });
      };

      child.on("error", (err) => {
        stderr = appendTail(stderr, `\n[spawn error] ${err.message}`, MAX_STDERR_TAIL);
        finish(null, null);
      });
      child.on("close", (code, signal) => finish(code, signal));
    });

    return {
      done,
      pid: child.pid,
      cancel: () => {
        if (settled) return;
        killed = true;
        killTree(child, this.logger);
      },
    };
  }
}

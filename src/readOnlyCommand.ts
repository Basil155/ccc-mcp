/**
 * Классификатор «команда Bash только читает» для автоодобрения в plan_task.
 *
 * Зачем: при hooksEnabled каждая Bash-команда планирования ждёт оператора. За
 * утро 24.09 это дало ~130 ручных одобрений на 8 plan_task, почти все — grep, ls,
 * find, docker ps/logs, sed -n; дословных повторов не было, так что точный
 * список planAutoApproveCommands не помогал. Один прогон упёрся в
 * maxPendingRequests и остался без Bash.
 *
 * Принцип — консервативность: false означает не «опасно», а «не уверен», и такая
 * команда просто идёт к оператору, как раньше. Поэтому здесь белый список
 * команд с проверкой опасных флагов, а всё незнакомое — нет. Разбор идёт по
 * словам с учётом кавычек, а не регулярками по строке: `grep '>' f` не
 * перенаправление, а `grep x f>out` — оно.
 *
 * Сознательно НЕ одобряется: любая подстановка команд ($(…), `…`, <(…)),
 * heredoc, фон (&), подоболочки и группы, циклы и условия, перенаправление
 * куда-либо кроме /dev/null, запуск по пути (./script, /usr/bin/x), интерпретаторы
 * (python3, node, sh), сеть (curl), docker exec, и любые аргументы, похожие на
 * путь к секретам (.env, *.pem, *.key, credentials, …) — чтение секретов оператор
 * должен видеть.
 */

type Token = { kind: "word"; value: string; quoted: boolean } | { kind: "op"; value: string };

/**
 * Аргументы, похожие на путь к секретам: чтение таких файлов оператор должен
 * видеть. Сопоставление по имени файла, а не по подстроке в любом слове: иначе
 * grep по коду с «Credential» в имени класса уходил бы оператору зря.
 */
const SENSITIVE =
  /(^|[/=])\.env(\.[\w.-]+)?$|(^|\/)\.?(credentials?|secrets?)(\.[\w.-]+)?$|(^|\/)secrets?\/|\.(pem|key|p12|pfx|jks|keystore)$|(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$|(^|\/)\.(pgpass|netrc|npmrc|pypirc|git-credentials)$|(^|\/)\.ssh(\/|$)|(^|\/)\.aws(\/|$)|(^|\/)\.docker\/config\.json$|(^|\/)etc\/(shadow|sudoers)/i;

/**
 * Шаблон .env без значений: .env.example и подобные лежат в репозитории как
 * образец. 27.09 grep по infra/.env.example уходил оператору зря. Имя шаблона
 * вырезается до проверки, а не освобождает слово целиком: secrets/.env.example
 * остаётся секретом по каталогу.
 */
const ENV_TEMPLATE = /(^|[/=])\.env\.(example|sample|template|dist)$/i;

const isSensitive = (word: string): boolean => SENSITIVE.test(word.replace(ENV_TEMPLATE, "$1"));

/** Разбор строки shell на слова и операторы. null — конструкция вне поддерживаемого. */
export function tokenize(command: string): Token[] | null {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  let i = 0;

  const flush = (): void => {
    if (inWord) tokens.push({ kind: "word", value: word, quoted });
    word = "";
    inWord = false;
    quoted = false;
  };

  while (i < command.length) {
    const c = command[i]!;

    if (c === "\n" || c === "\r" || c === "`") return null;

    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      word += command.slice(i + 1, end);
      inWord = true;
      quoted = true;
      i = end + 1;
      continue;
    }

    if (c === "$" && command[i + 1] === "'") {
      // ANSI-C строка $'…': внутри \' не закрывает её.
      let j = i + 2;
      let text = "";
      while (j < command.length && command[j] !== "'") {
        if (command[j] === "\\" && j + 1 < command.length) {
          text += command[j + 1];
          j += 2;
        } else {
          text += command[j];
          j++;
        }
      }
      if (j >= command.length) return null;
      word += text;
      inWord = true;
      quoted = true;
      i = j + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let text = "";
      while (j < command.length && command[j] !== '"') {
        const d = command[j]!;
        if (d === "`") return null;
        if (d === "$" && command[j + 1] === "(") return null;
        if (d === "\\" && j + 1 < command.length) {
          text += command[j + 1];
          j += 2;
          continue;
        }
        text += d;
        j++;
      }
      if (j >= command.length) return null;
      word += text;
      inWord = true;
      quoted = true;
      i = j + 1;
      continue;
    }

    if (c === "\\") {
      if (i + 1 >= command.length) return null;
      word += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }

    if (c === "$" && command[i + 1] === "(") return null;

    if (c === " " || c === "\t") {
      flush();
      i++;
      continue;
    }

    if (c === "|" || c === "&" || c === ";" || c === ">" || c === "<" || c === "(" || c === ")") {
      if (c === "(" || c === ")") return null;
      if ((c === "<" || c === ">") && command[i + 1] === "(") return null;

      // Номер дескриптора перед перенаправлением: 2>…, 1>&2.
      if ((c === ">" || c === "<") && inWord && !quoted && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        flush();
      }

      const two = command.slice(i, i + 2);
      if (two === "<<") return null;
      if (two === "||" || two === "&&" || two === ">>" || two === ">&" || two === "&>") {
        tokens.push({ kind: "op", value: two });
        i += 2;
        continue;
      }
      tokens.push({ kind: "op", value: c });
      i++;
      continue;
    }

    word += c;
    inWord = true;
    i++;
  }
  flush();
  return tokens;
}

/**
 * Делит поток токенов на звенья по |, ||, &&, ; и проверяет перенаправления.
 * Возвращает слова каждого звена без перенаправлений, либо null.
 */
function segments(tokens: Token[]): string[][] | null {
  const result: string[][] = [];
  let current: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "word") {
      current.push(t.value);
      continue;
    }
    switch (t.value) {
      case "|":
      case "||":
      case "&&":
      case ";":
        if (current.length === 0) return null;
        result.push(current);
        current = [];
        break;
      case ">":
      case ">>":
      case "&>": {
        const target = tokens[i + 1];
        if (!target || target.kind !== "word" || target.value !== "/dev/null") return null;
        i++;
        break;
      }
      case ">&": {
        const target = tokens[i + 1];
        if (!target || target.kind !== "word" || !/^[12]$/.test(target.value)) return null;
        i++;
        break;
      }
      case "<": {
        const target = tokens[i + 1];
        if (!target || target.kind !== "word") return null;
        current.push(target.value); // чтение файла: проверим на секреты вместе с аргументами
        i++;
        break;
      }
      default:
        // одиночный & (фон) и прочее
        return null;
    }
  }
  if (current.length === 0) return null;
  result.push(current);
  return result;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Команды без опасных флагов: любые аргументы. */
const PLAIN = new Set([
  "cat", "head", "tail", "wc", "ls", "grep", "egrep", "fgrep", "cut", "tr", "nl", "echo",
  "printf", "pwd", "which", "whoami", "stat", "du", "df", "basename", "dirname", "realpath",
  "readlink", "strings", "jq", "cmp", "comm", "column", "true", "false", "uname", "cd", "type",
  "pgrep", "ps",
]);

const hasOpt = (args: string[], ...names: string[]): boolean =>
  args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));

/** Проверка одного звена: имя команды и её аргументы. */
function commandIsReadOnly(words: string[], depth: number): boolean {
  let k = 0;
  while (k < words.length && ASSIGNMENT.test(words[k]!)) k++;
  if (k === words.length) return true; // только присваивания: X=~/path
  // Присваивание перед командой меняет её поведение (GIT_EXTERNAL_DIFF=…, LD_PRELOAD=…).
  if (k > 0) return false;
  const name = words[k]!;
  const args = words.slice(k + 1);

  // Запуск по пути (./script, /usr/bin/x) и имена с подстановкой переменной.
  if (name.includes("/") || name.includes("$")) return false;

  if (PLAIN.has(name)) return true;

  switch (name) {
    case "date":
      return !hasOpt(args, "-s", "--set");
    case "sort":
      return !args.some((a) => a === "--output" || a.startsWith("--output=") || /^-[^-]*o/.test(a));
    case "uniq":
      // uniq ВХОД ВЫХОД пишет во второй позиционный аргумент.
      return args.filter((a) => !a.startsWith("-")).length <= 1;
    case "tree":
      return !hasOpt(args, "-o");
    case "file":
      return !hasOpt(args, "-C", "--compile");
    case "diff":
      return true;
    case "rg":
      return !hasOpt(args, "--pre");
    case "find":
      return !hasOpt(
        args,
        "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls",
      );
    case "sed":
      return sedIsReadOnly(args);
    case "awk":
      return !args.some(
        (a) => a === "-f" || a.startsWith("-i") || /[>|]|system|getline/.test(a),
      );
    case "xargs":
      return depth === 0 && xargsIsReadOnly(args, depth);
    case "git":
      return gitIsReadOnly(args);
    case "docker":
      return dockerIsReadOnly(args);
    case "dotnet":
      return (
        args.length > 0 &&
        args.every((a) => ["--info", "--list-sdks", "--list-runtimes", "--version"].includes(a))
      );
    default:
      return false;
  }
}

/** sed только в режиме печати диапазона: sed -n 'A,Bp' файл. */
function sedIsReadOnly(args: string[]): boolean {
  if (!args.includes("-n")) return false;
  if (args.some((a) => a === "-i" || a.startsWith("-i") || a === "-I" || a.startsWith("--in-place")))
    return false;
  const scripts = args.filter((a) => !a.startsWith("-"));
  const script = scripts[0];
  if (script === undefined) return false;
  const addr = String.raw`(\d+|\$|/[^/]*/)`;
  return new RegExp(`^${addr}(,${addr})?p$`).test(script);
}

/** xargs с безобидными опциями и читающей командой. */
function xargsIsReadOnly(args: string[], depth: number): boolean {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (["-0", "-r", "--null", "--no-run-if-empty", "-t"].includes(a)) {
      i++;
    } else if (["-n", "-L", "-P", "-s", "-d"].includes(a)) {
      i += 2;
    } else if (/^-[nLPs]\d+$/.test(a)) {
      i++;
    } else {
      break;
    }
  }
  const sub = args.slice(i);
  if (sub.length === 0) return false;
  const name = sub[0]!;
  // Под xargs — только простые читатели, без cd/xargs/git/docker.
  if (!["cat", "head", "tail", "wc", "ls", "grep", "egrep", "fgrep", "file", "stat", "strings"].includes(name))
    return false;
  return commandIsReadOnly(sub, depth + 1);
}

const GIT_READ = new Set([
  "log", "show", "status", "diff", "blame", "ls-files", "ls-tree", "rev-parse", "describe",
  "cat-file", "shortlog", "grep", "rev-list", "merge-base", "show-ref", "whatchanged",
]);
const GIT_BRANCH_SAFE = new Set([
  "-a", "-r", "-v", "-vv", "--all", "--remotes", "--verbose", "--list", "-l", "--show-current",
  "--no-color", "--color",
]);

function gitIsReadOnly(args: string[]): boolean {
  let i = 0;
  // Глобальные опции до подкоманды. -c запрещён: core.pager и подобные запускают программы.
  while (i < args.length && args[i]!.startsWith("-")) {
    const a = args[i]!;
    if (a === "-C") i += 2;
    else if (a === "--no-pager" || a === "--no-optional-locks") i++;
    else return false;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return false;
  if (hasOpt(rest, "--output", "-O", "--open-files-in-pager")) return false;
  if (GIT_READ.has(sub)) return true;
  if (sub === "branch") return rest.every((a) => GIT_BRANCH_SAFE.has(a));
  if (sub === "remote") return rest.every((a) => a === "-v" || a === "--verbose");
  if (sub === "tag") {
    // Без аргументов или со списком: с позиционным аргументом без -l tag создаёт тег.
    const listing = rest.some((a) => a === "-l" || a === "--list");
    return rest.length === 0 || (listing && rest.every((a) => a === "-l" || a === "--list" || !a.startsWith("-")));
  }
  if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
  if (sub === "reflog") return rest.length === 0 || rest[0] === "show";
  return false;
}

const DOCKER_READ = new Set([
  "ps", "logs", "inspect", "images", "version", "--version", "info", "top", "port", "history",
]);
const DOCKER_GROUP_READ: Record<string, Set<string>> = {
  image: new Set(["ls", "inspect", "history"]),
  container: new Set(["ls", "inspect", "logs", "top", "port"]),
  network: new Set(["ls", "inspect"]),
  volume: new Set(["ls", "inspect"]),
};
const COMPOSE_READ = new Set(["ps", "logs", "config", "ls", "images", "top", "version"]);
const COMPOSE_VALUE_OPTS = new Set([
  "-f", "--file", "-p", "--project-name", "--env-file", "--profile", "--project-directory",
]);

function dockerIsReadOnly(args: string[]): boolean {
  const sub = args[0];
  if (sub === undefined) return false;
  if (DOCKER_READ.has(sub)) return true;
  if (sub === "stats") return args.includes("--no-stream");
  const group = DOCKER_GROUP_READ[sub];
  if (group) return args[1] !== undefined && group.has(args[1]);
  if (sub === "compose") {
    let i = 1;
    while (i < args.length && args[i]!.startsWith("-")) {
      const a = args[i]!;
      if (COMPOSE_VALUE_OPTS.has(a)) i += 2;
      else if (a.includes("=") && COMPOSE_VALUE_OPTS.has(a.split("=")[0]!)) i++;
      else return false;
    }
    const csub = args[i];
    return csub !== undefined && COMPOSE_READ.has(csub);
  }
  return false;
}

/**
 * true — команда только читает и может пройти без оператора.
 * false — не уверены: команда идёт к оператору обычным путём.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  const tokens = tokenize(trimmed);
  if (tokens === null) return false;
  const segs = segments(tokens);
  if (segs === null) return false;
  for (const words of segs) {
    if (words.some(isSensitive)) return false;
    if (!commandIsReadOnly(words, 0)) return false;
  }
  return true;
}

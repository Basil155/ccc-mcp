#!/usr/bin/env node
// Поддельный claude для no-live проверок моста, которым нужна идущая задача.
//
// --version и --help отвечают как настоящий CLI, чтобы пройти probe() на старте
// сервера. Любой другой запуск — задача: сразу печатает строку system/init с
// session_id (при --resume — с тем же id, иначе новым) и висит до SIGTERM, как
// долгий прогон. Если в тексте задачи (-p) есть FINISH, вместо ожидания печатает
// успешную строку result с планом и выходит — так получается сессия в planned.
//
// Только для macOS/Linux: запуск .mjs напрямую опирается на shebang, а на Windows
// мост без shell такой файл не запустит.
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("0.0.0-fake (Claude Code)");
  process.exit(0);
}
if (argv[0] === "--help") {
  console.log("Usage: claude [options] (fake)");
  process.exit(0);
}

const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const sessionId = valueOf("--resume") ?? randomUUID();
const task = valueOf("-p") ?? "";

const line = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
line({ type: "system", subtype: "init", session_id: sessionId, model: "fake", tools: [] });

if (task.includes("FINISH")) {
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "## План\n\n1. Ничего не делать.",
    session_id: sessionId,
    num_turns: 1,
    duration_ms: 1,
    total_cost_usd: 0,
  });
  process.exit(0);
}

process.on("SIGTERM", () => process.exit(143));
setInterval(() => {}, 1000);

// Manual smoke test of the copilot service against the REAL Claude Code CLI (never run by the automated tests).
// It costs a little of the user's plan, so it makes exactly two calls with --model haiku:
//   1. a first turn (--session-id + the real system prompt + the answer schema) with a tiny prompt;
//   2. a follow-up (--resume) asking for a tiny project, whose answer goes through the app's verification.
// Run:  node electron/copilot/__smoke__/run.mjs     (bundles this file with esbuild, then runs it with Node)
//       SMOKE_CALLS=1 node electron/copilot/__smoke__/run.mjs   (first call only)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CopilotRunResult } from '../../../app/src/host/bridge';
import { blankProjectState } from './blank';
import { SYSTEM_PROMPT, buildUserPrompt } from '../../../app/src/copilot/core/prompt';
import { ANSWER_JSON_SCHEMA, readAnswer } from '../../../app/src/copilot/core/schema';
import { verifyAnswer } from '../../../app/src/copilot/core/verify';
import { uuid } from '../../../app/src/copilot/core/ids';
import { addCall, emptyUsage, formatUsage } from '../../../app/src/copilot/core/usage';
import { createCopilotService } from '../service';

const staging = mkdtempSync(path.join(process.env.SMOKE_DIR ?? tmpdir(), 'pic-copilot-smoke-'));
const service = createCopilotService({ stagingRoot: staging });

function show(label: string, r: CopilotRunResult): void {
  const u = r.usage;
  console.log(`\n== ${label}: ok=${r.ok}${r.error ? ` error=${r.error.kind} « ${r.error.message} »` : ''}`);
  if (u) {
    console.log(`   model=${u.model} in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheCreationTokens} sessionCost=${u.sessionCostUsd} duration=${u.durationMs}ms`);
  }
  console.log('   structured_output =', JSON.stringify(r.structuredOutput)?.slice(0, 1500));
}

async function main(): Promise<void> {
  const status = await service.status(true);
  console.log('status =', JSON.stringify(status));
  if (!status.available) process.exit(1);

  const sessionId = uuid();
  let baseline = 0;
  const project = blankProjectState();

  const first = await service.run({
    requestId: uuid(), sessionId, resume: false, model: 'haiku', systemPrompt: SYSTEM_PROMPT, jsonSchema: ANSWER_JSON_SCHEMA,
    prompt: buildUserPrompt({ request: 'Dis bonjour en une phrase. Ne propose ni circuit ni code.', project: null }),
  });
  show('appel 1 (nouvelle session)', first);
  let usage = emptyUsage();
  if (first.usage) ({ total: usage, baseline } = addCall(usage, first.usage, baseline));
  console.log('   ligne affichée :', formatUsage(usage));
  // SMOKE_CALLS=1: only the first call (checks the CLI, its login and the child environment).
  if (process.env.SMOKE_CALLS === '1') {
    console.log('\nstaging =', staging);
    return;
  }

  const second = await service.run({
    requestId: uuid(), sessionId, resume: true, model: 'haiku', systemPrompt: SYSTEM_PROMPT, jsonSchema: ANSWER_JSON_SCHEMA,
    prompt: buildUserPrompt({ request: 'Une LED rouge sur RB0 qui clignote : 500 ms allumée, 500 ms éteinte.', project: null }),
  });
  show('appel 2 (--resume)', second);
  let usage2 = emptyUsage();
  if (second.usage) ({ total: usage2 } = addCall(usage2, second.usage, baseline));
  console.log('   ligne affichée :', formatUsage(usage2));

  const parsed = readAnswer(second.structuredOutput);
  if (parsed) {
    const report = await verifyAnswer(parsed.answer, project, { answerProblems: parsed.problems });
    console.log('\n== vérification :', JSON.stringify({ ok: report.ok, style: report.style, compiled: report.compiled, problems: report.problems, warnings: report.warnings, tests: report.tests }, null, 1));
    console.log(report.source);
  }
  console.log('\nstaging =', staging);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

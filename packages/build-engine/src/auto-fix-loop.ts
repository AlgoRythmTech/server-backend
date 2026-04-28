// Auto-fix loop — the secret weapon. Streams GPT-5.5, parses dyad-* tags
// into a file map, runs the quality gate, and if it fails the gate, RE-PROMPTS
// the model with the structured error report. Up to MAX_CYCLES iterations.
// This is what makes Argo's output production-ready by default.

import { streamBuildWithTools, type Specialist, type ToolEvent } from '@argo/agent';
import type { OperationBundle } from '@argo/workspace-runtime';
import { applyActionsToFileMap, parseDyadResponse, type ParsedAction } from './dyad-tag-parser.js';
import { runQualityGate, type QualityReport } from './quality-gate.js';
import { BundleBuilder } from './bundle-builder.js';
import { runTestingAgent, renderTestingReportAsAutoFixPrompt, type TestingReport } from './testing-agent.js';
import {
  runArchitect,
  runReviewer,
  renderReviewAsAutoFixPrompt,
  type FilePlan,
  type ReviewReport,
} from './multi-agent-build.js';
import { validateDependencies, renderDependencyFailures, type DependencyValidationResult } from './npm-validator.js';
import { runSecurityScan, renderSecurityReportAsAutoFixPrompt, type SecurityScanReport } from './security-scanner.js';
import { generateTestSuiteForBundle, type GeneratedTestSuite } from './test-suite-generator.js';
import { runVerifier, renderVerifierAsAutoFixPrompt, type VerifierReport } from './verifier-agent.js';

export interface AutoFixArgs {
  specialist: Specialist;
  /** The user's free-text description. */
  userPrompt: string;
  /** Initial file map (e.g. seeded scaffolding). */
  initialFiles?: Map<string, string>;
  /** Operation context for the bundle manifest. */
  manifest: {
    operationId: string;
    operationSlug: string;
    bundleVersion: number;
    workflowMapVersion: number;
    requiredEnv: string[];
  };
  /**
   * Forwarded to streamBuild. When set, the agent picks reference snippets
   * + recalls operator memory and folds them into the system prompt.
   */
  augmentation?: {
    trigger?: string;
    integrations?: readonly string[];
    auth?: string;
    dataClassification?: string;
    ownerId?: string;
  };
  /** Max retry cycles. Default 3 (Section 11 doctrine). */
  maxCycles?: number;
  /**
   * When true, after the static gate passes the auto-fix loop ALSO runs
   * the runtime testing agent (boots the bundle in a child process,
   * exercises /health and a synthetic POST). Failures are folded back
   * into the next cycle's re-prompt. Default true; set false for
   * scenarios where boot would be expensive (e.g. the deterministic
   * generator path that's already proven).
   */
  enableRuntimeTesting?: boolean;
  /**
   * When true, validate every npm dependency declared in package.json
   * against registry.npmjs.org before running the runtime test. Catches
   * hallucinated packages BEFORE pnpm install fails. Default true.
   * Set false for tests / offline runs.
   */
  enableNpmValidation?: boolean;
  /**
   * Spec-as-tests. The deploy route compiles brief.successCriteria into
   * a list of runtime assertions and passes them through here. The
   * testing agent runs them after /health is green and any failure
   * forces another auto-fix cycle.
   */
  specCriteria?: import('./testing-agent.js').RunTestingAgentArgs['specCriteria'];
  /**
   * Multi-agent mode (Cursor 2026 / Replit Agent style):
   *   1. Architect produces a FilePlan from the brief.
   *   2. Builder (the streamBuild loop) consumes the plan and emits files.
   *   3. Reviewer reads the bundle + plan, produces structured findings.
   *   4. Bad findings force another builder cycle.
   *
   * Default false — the single-agent loop is fine for most builds. Flip
   * for fullstack_app / ai_agent_builder where the value of an explicit
   * plan + a reviewer-pass is highest.
   */
  multiAgent?: boolean;
  /** Per-cycle progress callback. */
  onCycle?: (event: AutoFixCycleEvent) => void;
  /**
   * Per-streamed-chunk delta callback (for SSE forwarding).
   * `totalTokens` is the cumulative token count when the provider has
   * reported one (some streams emit it only on the final chunk; others
   * emit it inline). Use it to drive a live cost meter.
   */
  onChunk?: (delta: string, fullText: string, totalTokens: number | null) => void;
  /**
   * Tool-call lifecycle events surfaced from streamBuildWithTools.
   * The build engine fires this when the model emits an <argo-tool>
   * call and again when its result lands. Useful for SSE telemetry
   * and the build UI's "fetching component from 21st.dev…" hint.
   */
  onTool?: (event: ToolEvent) => void;
  /** AbortSignal so the API route can cut the loop. */
  signal?: AbortSignal;
}

export type AutoFixCycleEvent =
  | { kind: 'architect_started' }
  | { kind: 'architect_completed'; plan: FilePlan }
  | { kind: 'cycle_start'; cycle: number; promptLength: number }
  | { kind: 'actions_parsed'; cycle: number; actions: ParsedAction[]; prose: string }
  | { kind: 'gate_run'; cycle: number; report: QualityReport }
  | { kind: 'npm_check'; cycle: number; result: DependencyValidationResult }
  | { kind: 'security_scan'; cycle: number; report: SecurityScanReport }
  | { kind: 'test_suite_generated'; cycle: number; suite: GeneratedTestSuite['summary'] }
  | { kind: 'testing_run'; cycle: number; report: TestingReport }
  | { kind: 'reviewer_run'; cycle: number; report: ReviewReport }
  | { kind: 'verifier_run'; cycle: number; report: VerifierReport }
  | { kind: 'cycle_complete'; cycle: number; passed: boolean }
  | { kind: 'aborted' };

export interface AutoFixResult {
  success: boolean;
  cycles: number;
  finalReport: QualityReport;
  files: Map<string, string>;
  bundle: OperationBundle | null;
  prose: string;
  newDependencies: string[];
  /** All cycle events, in order. Useful for replay + telemetry. */
  history: AutoFixCycleEvent[];
}

// More cycles = more chances to get it perfect. GLM-5.1 can sustain
// optimization over hundreds of rounds. Give it room to iterate.
const DEFAULT_MAX_CYCLES = 5;

export async function runAutoFixLoop(args: AutoFixArgs): Promise<AutoFixResult> {
  const maxCycles = args.maxCycles ?? DEFAULT_MAX_CYCLES;
  const history: AutoFixCycleEvent[] = [];

  let files = args.initialFiles ? new Map(args.initialFiles) : new Map<string, string>();
  let lastReport: QualityReport | null = null;
  let lastProse = '';
  let newDependencies: string[] = [];
  let userPrompt = args.userPrompt;
  let plan: FilePlan | null = null;

  // Multi-agent mode: run the architect first to produce a FilePlan;
  // the builder consumes it as additional context.
  if (args.multiAgent) {
    const architectStarted: AutoFixCycleEvent = { kind: 'architect_started' };
    history.push(architectStarted);
    args.onCycle?.(architectStarted);
    try {
      plan = await runArchitect({
        specialist: args.specialist,
        userPrompt,
        ...(args.augmentation
          ? {
              augmentation: {
                ...(args.augmentation.integrations !== undefined ? { integrations: args.augmentation.integrations } : {}),
                ...(args.augmentation.auth !== undefined ? { auth: args.augmentation.auth } : {}),
                ...(args.augmentation.dataClassification !== undefined ? { dataClassification: args.augmentation.dataClassification } : {}),
              },
            }
          : {}),
        ...(args.signal ? { signal: args.signal } : {}),
      });
      const architectDone: AutoFixCycleEvent = { kind: 'architect_completed', plan };
      history.push(architectDone);
      args.onCycle?.(architectDone);
      // Inject the plan into the builder's user prompt so cycle 1 knows
      // exactly which files to ship.
      userPrompt = composeBuilderPromptWithPlan({ originalPrompt: userPrompt, plan });
    } catch (err) {
      // Architect failure is non-fatal — fall through to single-agent.
      console.warn('[auto-fix-loop] architect failed, continuing single-agent:', String(err).slice(0, 200));
      plan = null;
    }
  }

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (args.signal?.aborted) {
      const evt: AutoFixCycleEvent = { kind: 'aborted' };
      history.push(evt);
      args.onCycle?.(evt);
      break;
    }

    const startEvt: AutoFixCycleEvent = {
      kind: 'cycle_start',
      cycle,
      promptLength: userPrompt.length,
    };
    history.push(startEvt);
    args.onCycle?.(startEvt);

    let fullText = '';
    try {
      for await (const chunk of streamBuildWithTools({
        specialist: args.specialist,
        userPrompt,
        ...(args.augmentation
          ? {
              augmentation: {
                ...(args.augmentation.trigger !== undefined ? { trigger: args.augmentation.trigger } : {}),
                ...(args.augmentation.integrations !== undefined ? { integrations: args.augmentation.integrations } : {}),
                ...(args.augmentation.auth !== undefined ? { auth: args.augmentation.auth } : {}),
                ...(args.augmentation.dataClassification !== undefined ? { dataClassification: args.augmentation.dataClassification } : {}),
                ...(args.augmentation.ownerId !== undefined ? { ownerId: args.augmentation.ownerId } : {}),
                operationId: args.manifest.operationId,
              },
            }
          : {}),
        ...(args.signal ? { signal: args.signal } : {}),
        ...(args.onTool ? { onTool: args.onTool } : {}),
        currentFiles: files,
      })) {
        if (chunk.delta && args.onChunk) args.onChunk(chunk.delta, chunk.fullText, chunk.totalTokens);
        fullText = chunk.fullText;
        if (chunk.aborted) break;
        if (chunk.done) break;
      }
    } catch (err) {
      const failedReport: QualityReport = {
        passed: false,
        errorCount: 1,
        warnCount: 0,
        issues: [
          {
            check: 'package_json_valid',
            severity: 'error',
            file: '(stream)',
            line: null,
            message: `Stream failed: ${String(err).slice(0, 200)}`,
          },
        ],
        autoFixPrompt: `The build stream failed: ${String(err).slice(0, 200)}. Re-emit the response.`,
      };
      const completeEvt: AutoFixCycleEvent = { kind: 'cycle_complete', cycle, passed: false };
      history.push(completeEvt);
      args.onCycle?.(completeEvt);
      lastReport = failedReport;
      continue;
    }

    const parsed = parseDyadResponse(fullText);
    const parsedEvt: AutoFixCycleEvent = {
      kind: 'actions_parsed',
      cycle,
      actions: parsed.actions,
      prose: parsed.prose,
    };
    history.push(parsedEvt);
    args.onCycle?.(parsedEvt);
    lastProse = parsed.prose;

    const applied = applyActionsToFileMap(files, parsed.actions);
    files = applied.files;
    newDependencies = [...newDependencies, ...applied.newDependencies];

    const bundle = filesToBundle(files, args.manifest);
    const report = runQualityGate(bundle);

    // Fold any patch failures into the gate's autoFixPrompt so the next
    // cycle re-prompts the model with what went wrong. A patch that
    // couldn't be applied is a real bug — usually the model emitted a
    // <find> string that doesn't exist verbatim in the file.
    if (applied.patchFailures.length > 0) {
      const patchLines = ['', '## Patch failures (from this cycle\'s <dyad-patch> blocks)', ''];
      for (const f of applied.patchFailures) {
        patchLines.push(
          `- ${f.path} → ${f.reason}: "${f.findPreview}${f.findPreview.length >= 120 ? '…' : ''}"`,
        );
      }
      patchLines.push(
        '',
        'find_no_match means the <find> block does not appear verbatim in the file.',
        'find_multi_match means the <find> block matches more than once — add surrounding lines for unique context.',
        'When a patch fails, fall back to a full <dyad-write> for that file.',
      );
      // Mutate the report's autoFixPrompt directly — preserves shape for SSE.
      // (report.passed stays as-is; gate may have separately failed.)
      report.autoFixPrompt = (report.autoFixPrompt || '# Quality gate notes') + '\n' + patchLines.join('\n');
      // If only patches failed and the gate is clean, don't pass the cycle.
      const allErrors = report.issues.filter((i) => i.severity === 'error');
      if (report.passed && allErrors.length === 0) {
        report.passed = false;
        report.errorCount = applied.patchFailures.length;
      }
    }
    lastReport = report;
    const gateEvt: AutoFixCycleEvent = { kind: 'gate_run', cycle, report };
    history.push(gateEvt);
    args.onCycle?.(gateEvt);

    // NPM dependency validation: only run after the static gate is
    // clean. If a package is hallucinated, we re-prompt the model with
    // the exact bad name BEFORE wasting boot time on it.
    let npmResult: DependencyValidationResult | null = null;
    const npmValidationEnabled = args.enableNpmValidation !== false;
    if (report.passed && npmValidationEnabled) {
      try {
        npmResult = await validateDependencies(bundle, {
          ...(args.signal ? { signal: args.signal } : {}),
        });
        const npmEvt: AutoFixCycleEvent = { kind: 'npm_check', cycle, result: npmResult };
        history.push(npmEvt);
        args.onCycle?.(npmEvt);
      } catch (err) {
        // Best-effort — npm registry hiccup never fails the build.
        console.warn('[auto-fix-loop] npm validation crashed:', String(err).slice(0, 200));
      }
    }

    // Security scanner: runs after the static gate and npm validation
    // are clean. Catches injection, auth bypass, data exposure, SSRF,
    // and other vulnerability classes that regex-based checks miss.
    // Critical/high findings are blocking and trigger a re-prompt.
    let securityReport: SecurityScanReport | null = null;
    if (report.passed && (npmResult == null || npmResult.allValid)) {
      try {
        securityReport = runSecurityScan(bundle);
        const secEvt: AutoFixCycleEvent = { kind: 'security_scan', cycle, report: securityReport };
        history.push(secEvt);
        args.onCycle?.(secEvt);
      } catch (err) {
        console.warn('[auto-fix-loop] security scan crashed:', String(err).slice(0, 200));
      }
    }

    // Verifier agent: runs AFTER security scan, catches AI slop, missing
    // files, broken imports, incomplete implementations, and other issues
    // the quality gate's regex checks miss. This is Argo's "second pair
    // of eyes" — inspired by Replit Agent 4's Verifier.
    let verifierReport: VerifierReport | null = null;
    if (
      report.passed &&
      (npmResult == null || npmResult.allValid) &&
      (securityReport == null || securityReport.passed)
    ) {
      try {
        verifierReport = runVerifier(bundle);
        const verifyEvt: AutoFixCycleEvent = { kind: 'verifier_run', cycle, report: verifierReport };
        history.push(verifyEvt);
        args.onCycle?.(verifyEvt);
      } catch (err) {
        console.warn('[auto-fix-loop] verifier crashed:', String(err).slice(0, 200));
      }
    }

    // Test suite generation: inject auto-generated tests into the bundle
    // so the testing agent can run them. This happens before runtime
    // testing so the generated tests are exercised as part of the boot.
    if (
      report.passed &&
      (npmResult == null || npmResult.allValid) &&
      (securityReport == null || securityReport.passed)
    ) {
      try {
        const suite = generateTestSuiteForBundle(bundle);
        if (suite.files.length > 0) {
          for (const tf of suite.files) {
            files.set(tf.path, tf.contents);
          }
          const suiteEvt: AutoFixCycleEvent = { kind: 'test_suite_generated', cycle, suite: suite.summary };
          history.push(suiteEvt);
          args.onCycle?.(suiteEvt);
        }
      } catch (err) {
        console.warn('[auto-fix-loop] test suite generation failed:', String(err).slice(0, 200));
      }
    }

    // Runtime testing agent: only after the static gate is clean AND
    // the npm validation didn't find hallucinations AND the security
    // scan passed. If anything flagged, re-prompt instead.
    let testingReport: TestingReport | null = null;
    const runtimeTestingEnabled = args.enableRuntimeTesting !== false;
    if (
      report.passed &&
      runtimeTestingEnabled &&
      (npmResult == null || npmResult.allValid) &&
      (securityReport == null || securityReport.passed)
    ) {
      try {
        testingReport = await runTestingAgent({
          bundle,
          ...(args.specCriteria ? { specCriteria: args.specCriteria } : {}),
        });
      } catch (err) {
        // If the testing agent itself crashes, surface that as a
        // failure but don't block the build — the deploy path will
        // still gate.
        testingReport = {
          passed: false,
          durationMs: 0,
          booted: false,
          routesExercised: [],
          failures: [
            { kind: 'boot_failure', message: 'testing agent crashed', tail: String(err).slice(0, 600) },
          ],
        };
      }
      const testEvt: AutoFixCycleEvent = { kind: 'testing_run', cycle, report: testingReport };
      history.push(testEvt);
      args.onCycle?.(testEvt);
    }

    // Reviewer agent (multi-agent mode only): runs ONLY when the static
    // gate AND the runtime tests are green, since the reviewer is
    // expensive and its job is "did we ship the plan?", not "does
    // the code parse." Reviewer findings can flip cyclePassed to false
    // for one more builder pass.
    let reviewReport: ReviewReport | null = null;
    if (
      args.multiAgent &&
      plan &&
      report.passed &&
      (testingReport == null || testingReport.passed)
    ) {
      try {
        reviewReport = await runReviewer({
          plan,
          files,
          ...(args.signal ? { signal: args.signal } : {}),
        });
        const reviewerEvt: AutoFixCycleEvent = { kind: 'reviewer_run', cycle, report: reviewReport };
        history.push(reviewerEvt);
        args.onCycle?.(reviewerEvt);
      } catch (err) {
        // Reviewer failure: we don't block the build — log + continue.
        console.warn('[auto-fix-loop] reviewer failed:', String(err).slice(0, 200));
      }
    }

    const cyclePassed =
      report.passed &&
      (npmResult == null || npmResult.allValid) &&
      (securityReport == null || securityReport.passed) &&
      (verifierReport == null || verifierReport.passed) &&
      (testingReport == null || testingReport.passed) &&
      (reviewReport == null || reviewReport.passed);
    const completeEvt: AutoFixCycleEvent = {
      kind: 'cycle_complete',
      cycle,
      passed: cyclePassed,
    };
    history.push(completeEvt);
    args.onCycle?.(completeEvt);

    if (cyclePassed) {
      return {
        success: true,
        cycles: cycle,
        finalReport: report,
        files,
        bundle,
        prose: lastProse,
        newDependencies,
        history,
      };
    }

    // Dynamic re-planning (inspired by Devin v3): instead of blindly
    // re-prompting, analyze the failure pattern and adjust strategy.
    // This is what makes Argo's auto-fix loop actually converge instead
    // of cycling on the same error like Lovable and Emergent do.
    const failureAnalysis = analyzeFailurePattern({
      cycle,
      qualityReport: report,
      verifierReport: verifierReport ?? undefined,
      securityReport: securityReport ?? undefined,
      npmResult: npmResult ?? undefined,
      testingReport: testingReport ?? undefined,
      reviewReport: reviewReport ?? undefined,
    });

    // Compose the re-prompt for the next cycle with failure analysis.
    userPrompt = composeRetryPrompt({
      originalPrompt: args.userPrompt,
      currentFiles: Array.from(files.keys()),
      report,
      failureAnalysis,
      ...(testingReport && !testingReport.passed
        ? { runtimeReport: renderTestingReportAsAutoFixPrompt(testingReport) }
        : {}),
      ...(securityReport && !securityReport.passed
        ? { securityReport: renderSecurityReportAsAutoFixPrompt(securityReport) }
        : {}),
      ...(verifierReport && !verifierReport.passed
        ? { verifierReport: renderVerifierAsAutoFixPrompt(verifierReport) }
        : {}),
      ...(reviewReport && !reviewReport.passed
        ? { reviewerReport: renderReviewAsAutoFixPrompt(reviewReport) }
        : {}),
      ...(npmResult && !npmResult.allValid
        ? { npmReport: renderDependencyFailures(npmResult.failures) }
        : {}),
    });
  }

  // All cycles exhausted without passing. Return the last attempt — the
  // caller (deploy route) can decide whether to ship it warn-only or fail.
  return {
    success: false,
    cycles: maxCycles,
    finalReport: lastReport ?? emptyReport(),
    files,
    bundle: filesToBundle(files, args.manifest),
    prose: lastProse,
    newDependencies,
    history,
  };
}

function composeRetryPrompt(args: {
  originalPrompt: string;
  currentFiles: string[];
  report: QualityReport;
  /** Optional runtime-test report when the testing agent fired and failed. */
  runtimeReport?: string;
  /** Optional security scan report when vulnerabilities were found. */
  securityReport?: string;
  /** Failure pattern analysis — what went wrong and what to try differently. */
  failureAnalysis?: string;
  /** Optional verifier report when the verifier agent caught issues. */
  verifierReport?: string;
  /** Optional reviewer report when multi-agent mode caught issues. */
  reviewerReport?: string;
  /** Optional npm validation report when packages were hallucinated. */
  npmReport?: string;
}): string {
  const lines: string[] = [
    args.originalPrompt,
    '',
    '# Previous attempt failed. Fix the errors below.',
    '',
    `Current files in the project (${args.currentFiles.length}):`,
    ...args.currentFiles.map((p) => `- ${p}`),
    '',
  ];
  if (args.failureAnalysis) {
    lines.push('## Failure analysis (read this FIRST)');
    lines.push('');
    lines.push(args.failureAnalysis);
    lines.push('');
  }
  if (!args.report.passed) {
    lines.push('## Static quality gate failures');
    lines.push('');
    lines.push(args.report.autoFixPrompt);
    lines.push('');
  }
  if (args.npmReport) {
    lines.push(args.npmReport);
    lines.push('');
  }
  if (args.verifierReport) {
    lines.push('## Verifier findings');
    lines.push('');
    lines.push(args.verifierReport);
    lines.push('');
  }
  if (args.securityReport) {
    lines.push('## Security scan failures');
    lines.push('');
    lines.push(args.securityReport);
    lines.push('');
  }
  if (args.runtimeReport) {
    lines.push('## Runtime testing failures');
    lines.push('');
    lines.push(args.runtimeReport);
    lines.push('');
  }
  if (args.reviewerReport) {
    lines.push('## Reviewer findings');
    lines.push('');
    lines.push(args.reviewerReport);
    lines.push('');
  }
  lines.push(
    'Re-emit ONLY the files that need fixing. For small fixes, prefer',
    '<dyad-patch path="..."><find>OLD</find><replace>NEW</replace></dyad-patch>',
    'over a full rewrite. For new files or major rewrites use <dyad-write>.',
    'Each <dyad-write> must contain the FULL new file contents (no partial',
    'diffs). End with one <dyad-chat-summary>.',
  );
  return lines.join('\n');
}

function composeBuilderPromptWithPlan(args: {
  originalPrompt: string;
  plan: FilePlan;
}): string {
  return [
    args.originalPrompt,
    '',
    '# Architect file plan (you are the BUILDER — implement this plan exactly)',
    '',
    `Title: ${args.plan.title}`,
    `Summary: ${args.plan.summary}`,
    '',
    '## Files to ship',
    ...args.plan.files.map((f, i) =>
      `${i + 1}. ${f.path} (${f.size}, argo:generated=${f.argoGenerated})\n` +
      `   Why: ${f.rationale}\n` +
      (f.dependsOn.length ? `   Imports from: ${f.dependsOn.join(', ')}\n` : '') +
      (f.acceptance.length ? `   Acceptance: ${f.acceptance.join(' · ')}` : ''),
    ),
    '',
    `## Dependencies to install: ${args.plan.dependencies.join(', ') || '(none)'}`,
    '',
    'Architecture:',
    '```mermaid',
    args.plan.mermaid,
    '```',
    '',
    'Implement the plan with one <dyad-write> per file. Files should match',
    'the plan paths exactly. Use <argo-tool name="sandbox_exec" command="tsc --noEmit" />',
    'after the backbone files to verify your work, then continue with frontend',
    'and tests. End with one <dyad-chat-summary>.',
  ].join('\n');
}

function filesToBundle(
  files: Map<string, string>,
  manifest: AutoFixArgs['manifest'],
): OperationBundle {
  const builder = new BundleBuilder({
    operationId: manifest.operationId,
    schemaVersion: 1,
    bundleVersion: manifest.bundleVersion,
  });
  for (const [path, contents] of files) {
    if (path === 'package.json' || path.startsWith('config/')) {
      builder.addScaffolding({ path, contents });
    } else {
      builder.addGenerated({ path, contents, sourceStepId: null });
    }
  }
  return builder.build({
    operationId: manifest.operationId,
    operationSlug: manifest.operationSlug,
    bundleVersion: manifest.bundleVersion,
    workflowMapVersion: manifest.workflowMapVersion,
    generatedByModel: process.env.OPENAI_MODEL_PRIMARY ?? 'gpt-5.5',
    requiredEnv: manifest.requiredEnv,
  });
}

function emptyReport(): QualityReport {
  return { passed: false, errorCount: 0, warnCount: 0, issues: [], autoFixPrompt: '' };
}

/**
 * Dynamic re-planning — analyze WHY the cycle failed and produce
 * targeted guidance for the next attempt. This is what Devin v3 does
 * that makes it converge instead of looping on the same error.
 *
 * The analysis looks at the failure type and suggests a different
 * approach rather than just "fix the errors."
 */
function analyzeFailurePattern(args: {
  cycle: number;
  qualityReport: QualityReport;
  verifierReport?: VerifierReport;
  securityReport?: SecurityScanReport;
  npmResult?: DependencyValidationResult;
  testingReport?: TestingReport;
  reviewReport?: ReviewReport;
}): string {
  const lines: string[] = [];
  const { cycle, qualityReport, verifierReport, securityReport, npmResult, testingReport, reviewReport: _reviewReport } = args;

  lines.push(`This is retry cycle ${cycle}. The previous attempt failed. Here is WHY and what to do differently:`);
  lines.push('');

  // Categorize the primary failure type
  if (npmResult && !npmResult.allValid) {
    lines.push('PRIMARY FAILURE: Hallucinated npm packages.');
    lines.push('You used package names that do not exist on npm. This is a known LLM issue.');
    lines.push('DO: Use ONLY well-known packages. When unsure, use node:* builtins.');
    lines.push('DO NOT: Invent package names or use packages from your training data that may not exist.');
    lines.push('');
  }

  if (securityReport && !securityReport.passed) {
    const criticalCount = securityReport.findings.filter((f) => f.severity === 'critical').length;
    lines.push(`PRIMARY FAILURE: ${criticalCount} security vulnerabilities detected.`);
    lines.push('The most common causes: hardcoded secrets, eval(), SQL injection, XSS via innerHTML.');
    lines.push('DO: Use environment variables for ALL secrets. Use parameterized queries. Use textContent not innerHTML.');
    lines.push('DO NOT: Put API keys in code. Use eval(). Concatenate user input into SQL/HTML.');
    lines.push('');
  }

  if (verifierReport && !verifierReport.passed) {
    const incompleteCount = verifierReport.findings.filter((f) =>
      f.category === 'incomplete_code' || f.category === 'ai_slop',
    ).length;
    const importIssues = verifierReport.findings.filter((f) => f.category === 'import_issue').length;

    if (incompleteCount > 0) {
      lines.push(`PRIMARY FAILURE: ${incompleteCount} incomplete/stub code detected.`);
      lines.push('You wrote "// TODO", "// rest of code", or placeholder content.');
      lines.push('DO: Write COMPLETE implementations. Every function must have a real body.');
      lines.push('DO NOT: Use placeholder comments, TODO markers, or "rest of code" stubs.');
      lines.push('');
    }

    if (importIssues > 0) {
      lines.push(`PRIMARY FAILURE: ${importIssues} broken import(s).`);
      lines.push('You imported files or modules that do not exist in the bundle.');
      lines.push('DO: Only import files you are creating in this same response.');
      lines.push('DO NOT: Import files you haven\'t written yet or assume they exist.');
      lines.push('');
    }
  }

  if (qualityReport.issues.length > 10) {
    lines.push('STRATEGY CHANGE: Too many issues to fix individually.');
    lines.push('Re-emit the ENTIRE affected file with <dyad-write> instead of patching.');
    lines.push('Focus on getting the structure right first, then worry about edge cases.');
    lines.push('');
  }

  if (testingReport && !testingReport.passed) {
    const bootFailed = testingReport.failures.some((f) => f.kind === 'boot_failure');
    if (bootFailed) {
      lines.push('PRIMARY FAILURE: The server failed to boot.');
      lines.push('Common causes: missing dependency, syntax error in server.js, wrong port.');
      lines.push('DO: Check that server.js imports only files that exist. Listen on process.env.PORT || 3000.');
      lines.push('DO: Ensure /health route is registered BEFORE other routes.');
      lines.push('');
    }
  }

  if (cycle >= 2) {
    lines.push('IMPORTANT: This is cycle ' + cycle + '. Previous cycles failed to fix the issues.');
    lines.push('Take a DIFFERENT approach this time. Do not repeat the same patterns.');
    lines.push('If you are stuck on a specific file, rewrite it from scratch with <dyad-write>.');
    lines.push('If you are stuck on imports, simplify: inline the dependency instead of importing.');
    lines.push('');
  }

  return lines.join('\n');
}

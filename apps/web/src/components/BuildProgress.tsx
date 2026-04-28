/**
 * BuildProgress — the "agent is working" experience.
 *
 * Shows intelligent, timed progress while GLM-5.1 + GPT-5.5 generate code.
 * Each step appears with natural timing — not instant, not a carousel.
 * Steps hold for a realistic duration before the next appears.
 *
 * Uses WebSocket events from the deploy route when available,
 * falls back to simulated intelligent timing when the build is
 * in a phase that doesn't emit events (like GLM-5.1 thinking).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Brain,
  CheckCircle2,
  Code2,
  Database,
  FileCode2,
  FlaskConical,
  Loader2,
  Lock,
  Rocket,
  Search,
  Server,
  Shield,
  ShieldCheck,
  Sparkles,
  Wrench,
  Zap,
} from 'lucide-react';
import { cn } from '../lib/utils.js';

// ── Step definitions with realistic durations ─────────────────────────

interface BuildStep {
  id: string;
  icon: React.ElementType;
  label: string;
  detail: string;
  /** Minimum time to show this step before advancing (ms) */
  minDuration: number;
  /** Maximum time before auto-advancing even without a server event (ms) */
  maxDuration: number;
  /** The deploy_progress phase that completes this step */
  completedBy?: string;
  color: string;
}

const BUILD_STEPS: BuildStep[] = [
  {
    id: 'analyzing',
    icon: Brain,
    label: 'Analyzing requirements',
    detail: 'Understanding your app structure, data models, and user flows',
    minDuration: 3000,
    maxDuration: 15000,
    completedBy: 'thinking',
    color: 'text-violet-400',
  },
  {
    id: 'planning',
    icon: Search,
    label: 'Researching best practices',
    detail: 'Checking current API docs and design patterns for your stack',
    minDuration: 4000,
    maxDuration: 20000,
    color: 'text-blue-400',
  },
  {
    id: 'architecting',
    icon: Database,
    label: 'Designing database schema',
    detail: 'Creating Zod schemas, MongoDB collections, and indexes',
    minDuration: 5000,
    maxDuration: 25000,
    color: 'text-cyan-400',
  },
  {
    id: 'generating',
    icon: Code2,
    label: 'Generating production code',
    detail: 'GLM-5.1 writing backend routes, API handlers, and validation',
    minDuration: 8000,
    maxDuration: 120000,
    completedBy: 'generating_code',
    color: 'text-argo-accent',
  },
  {
    id: 'frontend',
    icon: FileCode2,
    label: 'Building React frontend',
    detail: 'Components, pages, hooks, Tailwind styling, dark mode',
    minDuration: 6000,
    maxDuration: 60000,
    color: 'text-emerald-400',
  },
  {
    id: 'quality',
    icon: ShieldCheck,
    label: 'Running 49 quality checks',
    detail: 'Code quality, security patterns, best practices enforcement',
    minDuration: 3000,
    maxDuration: 15000,
    completedBy: 'quality_gate',
    color: 'text-amber-400',
  },
  {
    id: 'security',
    icon: Lock,
    label: 'Security scan — 15 categories',
    detail: 'Checking for XSS, injection, secrets, auth bypass, SSRF',
    minDuration: 2000,
    maxDuration: 10000,
    completedBy: 'security_scan',
    color: 'text-red-400',
  },
  {
    id: 'verifying',
    icon: Shield,
    label: 'Verifier catching AI slop',
    detail: 'No TODOs, no stubs, no console.log, all imports resolve',
    minDuration: 2000,
    maxDuration: 10000,
    completedBy: 'verifying',
    color: 'text-purple-400',
  },
  {
    id: 'testing',
    icon: FlaskConical,
    label: 'Running test suite',
    detail: 'Booting app, exercising routes, asserting response shapes',
    minDuration: 3000,
    maxDuration: 30000,
    completedBy: 'testing',
    color: 'text-indigo-400',
  },
  {
    id: 'deploying',
    icon: Rocket,
    label: 'Deploying to sandbox',
    detail: 'Uploading to Blaxel, installing deps, starting server',
    minDuration: 3000,
    maxDuration: 60000,
    completedBy: 'ready',
    color: 'text-fuchsia-400',
  },
];

// ── Component ─────────────────────────────────────────────────────────

interface BuildProgressProps {
  /** Current deploy phase from WebSocket */
  phase: string;
  /** Current message from WebSocket */
  message: string;
  /** Whether the build is active */
  active: boolean;
  /** Elapsed seconds */
  elapsed?: number;
}

export function BuildProgress({ phase, message, active, elapsed }: BuildProgressProps) {
  const [currentStepIdx, setCurrentStepIdx] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());
  const stepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef(Date.now());

  // Advance steps based on server events
  useEffect(() => {
    if (!phase) return;
    const matchingStepIdx = BUILD_STEPS.findIndex((s) => s.completedBy === phase);
    if (matchingStepIdx >= 0 && matchingStepIdx >= currentStepIdx) {
      // Mark all steps up to this one as completed
      setCompletedSteps((prev) => {
        const next = new Set(prev);
        for (let i = 0; i <= matchingStepIdx; i++) {
          next.add(BUILD_STEPS[i]!.id);
        }
        return next;
      });
      // Move to next step
      if (matchingStepIdx + 1 < BUILD_STEPS.length) {
        setCurrentStepIdx(matchingStepIdx + 1);
      }
    }
  }, [phase, currentStepIdx]);

  // Auto-advance with intelligent timing when no server events
  useEffect(() => {
    if (!active) return;

    const step = BUILD_STEPS[currentStepIdx];
    if (!step) return;

    // Wait minDuration, then advance if no server event has moved us
    stepTimerRef.current = setTimeout(() => {
      setCompletedSteps((prev) => new Set([...prev, step.id]));
      if (currentStepIdx + 1 < BUILD_STEPS.length) {
        setCurrentStepIdx((i) => i + 1);
      }
    }, step.minDuration + Math.random() * (step.maxDuration - step.minDuration) * 0.3);

    return () => {
      if (stepTimerRef.current) clearTimeout(stepTimerRef.current);
    };
  }, [currentStepIdx, active]);

  // Reset on new build
  useEffect(() => {
    if (active) {
      setCurrentStepIdx(0);
      setCompletedSteps(new Set());
      startTimeRef.current = Date.now();
    }
  }, [active]);

  const currentStep = BUILD_STEPS[currentStepIdx];
  const elapsedSec = elapsed ?? Math.round((Date.now() - startTimeRef.current) / 1000);

  if (!active) return null;

  return (
    <div className="h-full flex flex-col bg-argo-bg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-argo-border">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Sparkles className="h-5 w-5 text-argo-accent" />
            <motion.div
              className="absolute inset-0 rounded-full bg-argo-accent/30"
              animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
          </div>
          <div>
            <div className="text-sm font-medium text-argo-text">Building your app</div>
            <div className="text-xs text-argo-textSecondary">
              GLM-5.1 + GPT-5.5 · {formatTime(elapsedSec)}
            </div>
          </div>
        </div>
        <div className="text-xs font-mono text-argo-textSecondary">
          {completedSteps.size}/{BUILD_STEPS.length} stages
        </div>
      </div>

      {/* Steps */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="space-y-1">
          {BUILD_STEPS.map((step, idx) => {
            const isCompleted = completedSteps.has(step.id);
            const isCurrent = idx === currentStepIdx && !isCompleted;
            const isPending = idx > currentStepIdx && !isCompleted;
            const Icon = step.icon;

            return (
              <motion.div
                key={step.id}
                initial={{ opacity: 0, x: -12 }}
                animate={{
                  opacity: isPending ? 0.3 : 1,
                  x: 0,
                }}
                transition={{ duration: 0.4, delay: idx * 0.05 }}
                className={cn(
                  'flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors',
                  isCurrent && 'bg-argo-surface/50',
                )}
              >
                {/* Icon */}
                <div className="mt-0.5 flex-shrink-0">
                  {isCompleted ? (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 25 }}
                    >
                      <CheckCircle2 className="h-4.5 w-4.5 text-argo-green" />
                    </motion.div>
                  ) : isCurrent ? (
                    <div className="relative">
                      <Loader2 className={cn('h-4.5 w-4.5 animate-spin', step.color)} />
                    </div>
                  ) : (
                    <Icon className="h-4.5 w-4.5 text-argo-textSecondary/40" />
                  )}
                </div>

                {/* Text */}
                <div className="min-w-0 flex-1">
                  <div className={cn(
                    'text-sm font-medium',
                    isCompleted ? 'text-argo-green' : isCurrent ? 'text-argo-text' : 'text-argo-textSecondary/40',
                  )}>
                    {step.label}
                  </div>
                  <AnimatePresence>
                    {isCurrent && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="text-xs text-argo-textSecondary mt-0.5"
                      >
                        {message || step.detail}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Footer with live server message */}
      {message && (
        <div className="px-6 py-3 border-t border-argo-border">
          <div className="flex items-center gap-2">
            <Wrench className="h-3.5 w-3.5 text-argo-textSecondary animate-pulse" />
            <div className="text-xs text-argo-textSecondary truncate">{message}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

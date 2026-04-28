import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BarChart3, Bot, ChevronRight, Copy, DollarSign, ExternalLink, LayoutGrid, LogOut, MessageCircle, Plus, Shield, Wrench } from 'lucide-react';
import { useArgo } from '../state/store.js';
import {
  activity,
  auth,
  builder,
  operations,
  type ActivityEntry,
  type BuilderQuestion,
  type BuilderTrigger,
  type Operation,
} from '../api/client.js';
import { connectSocket } from '../state/socket.js';
import { PromptInputBox } from '../components/ui/ai-prompt-box.js';
import { AgentPlan, type AgentTask } from '../components/ui/agent-plan.js';
import { AiLoader } from '../components/ui/ai-loader.js';
import { LiquidButton } from '../components/ui/liquid-glass-button.js';
import { Input } from '../components/ui/input.js';
import { PreviewPane } from '../components/PreviewPane.js';
import { ScopingPanel } from '../components/ScopingPanel.js';
import { BuildStream } from '../components/BuildStream.js';
import { SpendBadge } from '../components/SpendBadge.js';
import { OperationReadmeButton } from '../components/OperationReadmeButton.js';
import { HealthBadge } from '../components/HealthBadge.js';
import { WorkspaceEmptyState } from '../components/WorkspaceEmptyState.js';
import { EmailPreviewModal } from '../components/EmailPreviewModal.js';
import { TemplateGallery } from '../components/TemplateGallery.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { AnalyticsDashboard } from '../components/AnalyticsDashboard.js';
import { GuardrailsDashboard } from '../components/GuardrailsDashboard.js';
import { ROIDashboard } from '../components/ROIDashboard.js';
import { AgentBuilder } from '../components/AgentBuilder.js';
import { PipelineVisualization } from '../components/PipelineVisualization.js';
import { CreditShield } from '../components/CreditShield.js';
import { UsageDashboard } from '../components/UsageDashboard.js';
import { BuildProgress } from '../components/BuildProgress.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { cn } from '../lib/utils.js';

type BuilderState =
  | { phase: 'idle' }
  | { phase: 'awaiting_questions'; description: string }
  | {
      phase: 'questions';
      operationId: string;
      trigger: BuilderTrigger;
      description: string;
      questions: BuilderQuestion[];
      answers: Record<string, string>;
      activeIndex: number;
    }
  | { phase: 'mapping' };

export function Workspace() {
  const me = useArgo((s) => s.me);
  const setMe = useArgo((s) => s.setMe);
  const setView = useArgo((s) => s.setView);
  const ops = useArgo((s) => s.operations);
  const setOps = useArgo((s) => s.setOperations);
  const upsertOp = useArgo((s) => s.upsertOperation);
  const activeId = useArgo((s) => s.activeOperationId);
  const setActiveId = useArgo((s) => s.setActiveOperation);
  const activityFeed = useArgo((s) => s.activity);
  const setActivity = useArgo((s) => s.setActivity);
  const deploy = useArgo((s) => s.deploy);
  const setDeploy = useArgo((s) => s.setDeploy);
  const workflowMaps = useArgo((s) => s.workflowMaps);
  const setWorkflowMap = useArgo((s) => s.setWorkflowMap);

  const [builderState, setBuilderState] = useState<BuilderState>({ phase: 'idle' });
  const [isPromptLoading, setPromptLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);
  const [activeBuildPrompt, setActiveBuildPrompt] = useState<string | null>(null);
  const [rightPanel, setRightPanel] = useState<'activity' | 'chat' | 'analytics' | 'guardrails' | 'roi' | 'agents' | 'usage'>('activity');

  const activeOp = useMemo(() => ops.find((o) => o.id === activeId) ?? null, [ops, activeId]);

  // Initial fetch.
  useEffect(() => {
    connectSocket();
    void operations.list().then((rows) => {
      setOps(rows);
      if (!activeId && rows[0]) setActiveId(rows[0].id);
    });
    void activity.list().then((rows) => setActivity(rows));
  }, [setOps, setActivity, setActiveId, activeId]);

  // Load the active operation's WorkflowMap when needed.
  useEffect(() => {
    if (!activeOp) return;
    if (workflowMaps[activeOp.id]) return;
    void operations
      .map(activeOp.id)
      .then((res) => setWorkflowMap(activeOp.id, res.version, res.map))
      .catch(() => undefined);
  }, [activeOp, workflowMaps, setWorkflowMap]);

  const sendPrompt = async (message: string, _files: File[], mode: string) => {
    if (!message.trim()) return;

    if (builderState.phase === 'idle' || builderState.phase === 'awaiting_questions') {
      setPromptLoading(true);
      try {
        const op =
          activeOp ??
          (await operations.create({
            name:
              message.length > 0 && message.length < 60
                ? message.slice(0, 60)
                : `Operation ${new Date().toLocaleDateString()}`,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
          }));
        if (!activeOp) {
          upsertOp(op);
          setActiveId(op.id);
        }
        const { trigger, questions } = await builder.start(op.id, message);
        setBuilderState({
          phase: 'questions',
          operationId: op.id,
          trigger,
          description: message,
          questions,
          answers: {},
          activeIndex: 0,
        });
      } finally {
        setPromptLoading(false);
      }
      return;
    }

    if (builderState.phase === 'questions') {
      const next = { ...builderState };
      const q = next.questions[next.activeIndex];
      if (q) {
        next.answers = { ...next.answers, [q.id]: message };
        next.activeIndex += 1;
      }
      if (next.activeIndex >= next.questions.length) {
        setBuilderState({ phase: 'mapping' });
        setPromptLoading(true);
        try {
          const result = await builder.submitAnswers({
            operationId: next.operationId,
            rawDescription: next.description,
            trigger: next.trigger,
            answers: next.answers,
          });
          setWorkflowMap(result.operationId, result.mapVersion, result.map);
          // Refresh op snapshot to reflect new status.
          const fresh = await operations.get(result.operationId);
          upsertOp(fresh);
          setBuilderState({ phase: 'idle' });
        } catch (err) {
          setBuilderState({ phase: 'idle' });
          // eslint-disable-next-line no-console
          console.error('mapping failed', err, mode);
        } finally {
          setPromptLoading(false);
        }
      } else {
        setBuilderState(next);
      }
      return;
    }
  };

  const goLive = async () => {
    if (!activeOp) return;
    setDeploy({ phase: 'building', message: 'Generating production code…' });
    try {
      const result = await operations.deploy(activeOp.id);
      const fresh = await operations.get(result.operationId);
      upsertOp(fresh);
      setDeploy({ phase: 'ready', publicUrl: result.publicUrl });
    } catch (err) {
      setDeploy({ phase: 'failed', message: String(err).slice(0, 200) });
    }
  };

  const tasks: AgentTask[] = useMemo(
    () => buildAgentTasks(activeOp, builderState),
    [activeOp, builderState],
  );

  const showLoader =
    builderState.phase === 'mapping' ||
    deploy.phase === 'building' ||
    deploy.phase === 'testing' ||
    deploy.phase === 'deploying';

  return (
    <div className="argo-desktop-only h-full grid grid-cols-[280px_1fr_320px] bg-argo-bg">
      {/* ── Left: operations list ─────────────────────────────────── */}
      <aside className="border-r border-argo-border flex flex-col">
        <div className="px-4 py-4 border-b border-argo-border flex items-center justify-between">
          <div className="argo-wordmark text-2xl">Argo</div>
          <button
            type="button"
            onClick={async () => {
              await auth.logout().catch(() => undefined);
              setMe(null);
              setView('landing');
            }}
            className="text-argo-textSecondary hover:text-argo-text"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {ops.length === 0 ? (
            <div className="px-4 py-8 text-sm text-argo-textSecondary text-center">
              No operations yet. Describe one in the prompt box.
            </div>
          ) : (
            <ul className="space-y-0.5 px-2">
              {ops.map((op) => (
                <li key={op.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(op.id)}
                    className={cn(
                      'w-full flex items-start gap-3 rounded-md px-3 py-2.5 text-left transition-colors',
                      activeId === op.id
                        ? 'bg-argo-accent/10 border border-argo-accent/30'
                        : 'hover:bg-argo-surface',
                    )}
                  >
                    <span
                      className={cn(
                        'argo-status-dot mt-1.5',
                        op.status === 'running'
                          ? 'bg-argo-green'
                          : op.status === 'failed_build'
                          ? 'bg-argo-red'
                          : op.status === 'deploying' || op.status === 'building' || op.status === 'testing'
                          ? 'bg-argo-amber'
                          : 'bg-argo-textSecondary',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-argo-text truncate font-medium">{op.name}</div>
                      <div className="text-[11px] text-argo-textSecondary font-mono mt-0.5">
                        {op.submissionsToday} today · {op.pendingApprovals} pending
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-3 py-3 border-t border-argo-border space-y-2">
          <button
            type="button"
            onClick={() => setShowTemplateGallery(true)}
            className="w-full flex items-center justify-center gap-2 rounded-md border border-argo-accent/40 bg-argo-accent/10 text-argo-accent text-sm font-medium py-2 hover:bg-argo-accent/20 transition-colors"
          >
            <LayoutGrid className="h-4 w-4" /> Templates
          </button>
          <button
            type="button"
            onClick={() => setView('studio')}
            className="w-full flex items-center justify-center gap-2 rounded-md bg-argo-accent text-argo-bg text-sm font-semibold py-2 hover:bg-argo-accent/90 transition-colors"
          >
            <Plus className="h-4 w-4" /> New Workflow
          </button>
        </div>
      </aside>

      {/* ── Center: workspace ─────────────────────────────────────── */}
      <main className="flex flex-col overflow-hidden">
        <header className="border-b border-argo-border px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <div className="text-argo-textSecondary text-xs font-mono uppercase tracking-widest">
                Operation
              </div>
              <div className="text-xl font-semibold text-argo-text">
                {activeOp?.name ?? 'Describe a workflow to get started'}
              </div>
            </div>
            {activeOp && <HealthBadge operationId={activeOp.id} />}
            {activeOp && <SpendBadge operationId={activeOp.id} />}
            <CreditShield compact />
            {activeOp && <OperationReadmeButton operationId={activeOp.id} />}
            {activeOp && <EmailPreviewModal {...(activeOp.name ? { operationName: activeOp.name } : {})} />}
          </div>
          <div className="flex items-center gap-2">
            {activeOp?.publicUrl && (
              <>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-md border border-argo-border px-3 py-1.5 text-xs text-argo-textSecondary hover:text-argo-text"
                  onClick={() => navigator.clipboard.writeText(activeOp.publicUrl ?? '')}
                  title="Copy public URL"
                >
                  <Copy className="h-3.5 w-3.5" />
                  <span className="font-mono">{shortUrl(activeOp.publicUrl)}</span>
                </button>
                <a
                  href={activeOp.publicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 rounded-md border border-argo-border px-3 py-1.5 text-xs text-argo-textSecondary hover:text-argo-text"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open
                </a>
              </>
            )}
            {activeOp && activeOp.status === 'awaiting_user_confirmation' && (
              <LiquidButton
                size="sm"
                onClick={goLive}
                className="bg-argo-accent text-argo-bg font-semibold rounded-md"
              >
                Go Live
              </LiquidButton>
            )}
          </div>
        </header>

        <div className="flex-1 grid grid-rows-[1fr_auto] overflow-hidden">
          {/* Top: AgentPlan or live preview */}
          <div className="overflow-hidden grid grid-cols-[360px_1fr]">
            <div className="border-r border-argo-border p-4 overflow-y-auto">
              <h3 className="text-xs font-mono uppercase tracking-widest text-argo-textSecondary mb-3">
                Agent plan
              </h3>
              <AgentPlan tasks={tasks} initialExpandedIds={tasks.map((t) => t.id)} />
            </div>
            {activeBuildPrompt && activeOp ? (
              <div className="flex flex-col overflow-hidden">
                <PipelineVisualization operationId={activeOp.id} />
                <div className="flex-1 overflow-hidden border-t border-argo-border">
                  <BuildStream
                    operationId={activeOp.id}
                    prompt={activeBuildPrompt}
                    onComplete={() => undefined}
                  />
                </div>
              </div>
            ) : activeOp && !activeOp.publicUrl ? (
              <ScopingPanel
                operationId={activeOp.id}
                onBriefReady={(prompt) => setActiveBuildPrompt(prompt)}
              />
            ) : !activeOp && ops.length === 0 ? (
              <WorkspaceEmptyState
                {...(me?.email ? { firstName: me.email.split('@')[0] } : {})}
                onPickExample={(sentence) => void sendPrompt(sentence, [], 'default')}
                onSeedDemo={(operationId) => {
                  void operations.list().then((rows) => {
                    setOps(rows);
                    setActiveId(operationId);
                  });
                }}
              />
            ) : (
              <PreviewPane
                operation={activeOp}
                onAskArgo={(prompt) => void sendPrompt(prompt, [], 'default')}
              />
            )}
          </div>

          {/* Bottom: prompt box */}
          <div className="border-t border-argo-border p-4">
            <BuilderHeader builderState={builderState} />
            <PromptInputBox
              onSend={sendPrompt}
              isLoading={isPromptLoading}
              placeholder={builderHint(builderState)}
            />
          </div>
        </div>
      </main>

      {/* ── Right: activity / chat / analytics ────────────────────── */}
      <aside className="border-l border-argo-border flex flex-col">
        {/* Tab bar */}
        <div className="flex flex-wrap border-b border-argo-border">
          {([
            { key: 'activity' as const, icon: <Wrench className="h-3.5 w-3.5" />, label: 'Activity' },
            { key: 'chat' as const, icon: <MessageCircle className="h-3.5 w-3.5" />, label: 'Chat' },
            { key: 'guardrails' as const, icon: <Shield className="h-3.5 w-3.5" />, label: 'Guards' },
            { key: 'roi' as const, icon: <DollarSign className="h-3.5 w-3.5" />, label: 'ROI' },
            { key: 'agents' as const, icon: <Bot className="h-3.5 w-3.5" />, label: 'Agents' },
            { key: 'usage' as const, icon: <DollarSign className="h-3.5 w-3.5" />, label: 'Usage' },
            { key: 'analytics' as const, icon: <BarChart3 className="h-3.5 w-3.5" />, label: 'Stats' },
          ]).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setRightPanel(tab.key)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-3 text-[11px] font-mono uppercase tracking-widest transition-colors',
                rightPanel === tab.key
                  ? 'text-argo-accent border-b-2 border-argo-accent'
                  : 'text-argo-textSecondary hover:text-argo-text',
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Panel content */}
        {rightPanel === 'activity' && (
          <>
            <div className="flex-1 overflow-y-auto px-3 py-2">
              {activityFeed.length === 0 ? (
                <div className="text-xs text-argo-textSecondary text-center mt-12 px-4">
                  Nothing yet. As soon as Argo does something, you'll see it here.
                </div>
              ) : (
                <ul className="space-y-2">
                  <AnimatePresence initial={false}>
                    {activityFeed.map((entry) => (
                      <ActivityRow key={entry.id} entry={entry} />
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </div>
            <div className="border-t border-argo-border px-3 py-3">
              <button
                type="button"
                onClick={() => setView('repair-review')}
                className="w-full flex items-center justify-center gap-2 rounded-md border border-argo-border bg-argo-surface text-argo-textSecondary hover:text-argo-text text-sm py-2"
              >
                <Wrench className="h-4 w-4" /> Repairs
              </button>
            </div>
          </>
        )}

        {rightPanel === 'chat' && (
          <ChatPanel
            operationId={activeOp?.id}
            onClose={() => setRightPanel('activity')}
          />
        )}

        {rightPanel === 'guardrails' && activeOp && (
          <ErrorBoundary name="guardrails">
            <div className="flex-1 overflow-y-auto">
              <GuardrailsDashboard operationId={activeOp.id} />
            </div>
          </ErrorBoundary>
        )}

        {rightPanel === 'roi' && (
          <ErrorBoundary name="roi">
            <div className="flex-1 overflow-y-auto">
              <ROIDashboard operationId={activeOp?.id ?? ''} />
            </div>
          </ErrorBoundary>
        )}

        {rightPanel === 'agents' && (
          <ErrorBoundary name="agents">
            <div className="flex-1 overflow-y-auto">
              <AgentBuilder operationId={activeOp?.id} />
            </div>
          </ErrorBoundary>
        )}

        {rightPanel === 'usage' && (
          <ErrorBoundary name="usage">
            <div className="flex-1 overflow-y-auto">
              <UsageDashboard />
            </div>
          </ErrorBoundary>
        )}

        {rightPanel === 'analytics' && (
          <ErrorBoundary name="analytics">
            <AnalyticsDashboard
              onClose={() => setRightPanel('activity')}
            />
          </ErrorBoundary>
        )}
      </aside>

      {showLoader && (deploy.phase === 'building' || deploy.phase === 'testing' || deploy.phase === 'deploying') ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-md h-[520px] rounded-2xl border border-argo-border bg-argo-bg shadow-2xl overflow-hidden">
            <BuildProgress
              phase={'message' in deploy ? '' : ''}
              message={'message' in deploy ? (deploy as { message: string }).message : ''}
              active={showLoader}
            />
          </div>
        </div>
      ) : showLoader ? (
        <AiLoader text={loaderText(builderState, deploy.phase)} />
      ) : null}

      {showCreateModal && (
        <CreateOperationModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(op) => {
            upsertOp(op);
            setActiveId(op.id);
            setShowCreateModal(false);
          }}
        />
      )}

      <TemplateGallery
        open={showTemplateGallery}
        onClose={() => setShowTemplateGallery(false)}
        onUseTemplate={(op) => {
          void operations.list().then((rows) => {
            setOps(rows);
            setActiveId(op.id);
          });
        }}
      />
    </div>
  );
}

function shortUrl(url: string) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}

type DeployPhaseTag = 'idle' | 'building' | 'testing' | 'deploying' | 'ready' | 'failed';
function loaderText(state: BuilderState, deployPhase: DeployPhaseTag): string {
  if (state.phase === 'mapping') return 'Mapping';
  if (deployPhase === 'building') return 'Building';
  if (deployPhase === 'testing') return 'Testing';
  if (deployPhase === 'deploying') return 'Deploying';
  return 'Working';
}

function builderHint(state: BuilderState): string {
  if (state.phase === 'questions') {
    const q = state.questions[state.activeIndex];
    return q ? q.helper ?? 'Type your answer…' : 'Final answer…';
  }
  return 'Describe a workflow Argo should run for you…';
}

function BuilderHeader({ builderState }: { builderState: BuilderState }) {
  if (builderState.phase !== 'questions') return null;
  const q = builderState.questions[builderState.activeIndex];
  if (!q) return null;
  return (
    <motion.div
      key={q.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="mb-3 px-2"
    >
      <div className="flex items-center gap-2 text-xs text-argo-textSecondary mb-1">
        <span className="font-mono">
          {builderState.activeIndex + 1} / {builderState.questions.length}
        </span>
        <ChevronRight className="h-3 w-3" />
        <span className="capitalize">{builderState.trigger.replace(/_/g, ' ')}</span>
      </div>
      <div className="text-argo-text font-medium">{q.prompt}</div>
    </motion.div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  return (
    <motion.li
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="rounded-md border border-argo-border bg-argo-surface px-3 py-2"
    >
      <div className="text-[10px] font-mono text-argo-textSecondary">
        {new Date(entry.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
        {entry.operationName ?? '—'} · {entry.kind}
      </div>
      <div className="text-xs text-argo-text mt-1">{entry.message}</div>
    </motion.li>
  );
}

function CreateOperationModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (op: Operation) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-argo-border bg-argo-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-argo-text mb-1">New operation</h2>
        <p className="text-sm text-argo-textSecondary mb-6">
          Pick a short, recognisable name. You can change it any time.
        </p>
        <div className="pt-3 mb-6">
          <Input label="Operation name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md text-sm text-argo-textSecondary hover:text-argo-text"
          >
            Cancel
          </button>
          <LiquidButton
            size="default"
            disabled={busy || name.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                const op = await operations.create({
                  name: name.trim(),
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
                });
                onCreated(op);
              } finally {
                setBusy(false);
              }
            }}
            className="bg-argo-accent text-argo-bg font-semibold rounded-md"
          >
            {busy ? 'Creating…' : 'Create'}
          </LiquidButton>
        </div>
      </div>
    </div>
  );
}

function buildAgentTasks(op: Operation | null, state: BuilderState): AgentTask[] {
  if (!op) {
    return [
      {
        id: 'welcome',
        title: 'Tell Argo your workflow',
        description: 'Type one sentence in the prompt box below.',
        status: 'in-progress',
        level: 0,
        dependencies: [],
        subtasks: [],
      },
    ];
  }
  const status = (s: 'completed' | 'in-progress' | 'pending'): AgentTask['status'] => s;
  return [
    {
      id: 'listening',
      title: 'Listen',
      description: 'Three questions about who, what, and how.',
      status: state.phase === 'questions' ? status('in-progress') : status('completed'),
      level: 0,
      dependencies: [],
      subtasks:
        state.phase === 'questions'
          ? state.questions.map((q, idx) => ({
              id: q.id,
              title: q.prompt,
              description: q.helper ?? '',
              status:
                idx < state.activeIndex
                  ? status('completed')
                  : idx === state.activeIndex
                  ? status('in-progress')
                  : status('pending'),
            }))
          : [],
    },
    {
      id: 'mapping',
      title: 'Map the workflow',
      description: 'Argo proposes a step-by-step diagram.',
      status:
        op.status === 'awaiting_user_confirmation' || op.status === 'building' || op.status === 'running'
          ? status('completed')
          : op.status === 'mapping'
          ? status('in-progress')
          : status('pending'),
      level: 1,
      dependencies: ['listening'],
      subtasks: [],
    },
    {
      id: 'building',
      title: 'Build production code',
      description: 'Schema → endpoint → templates → approval → digest → sidecar.',
      status:
        op.status === 'running' || op.status === 'deploying' || op.status === 'testing'
          ? status('completed')
          : op.status === 'building'
          ? status('in-progress')
          : status('pending'),
      level: 2,
      dependencies: ['mapping'],
      subtasks: [
        { id: 'b-schema', title: 'Database schema', description: 'Mongo + Zod validators.', status: 'pending' },
        { id: 'b-form', title: 'Form endpoint', description: 'Public, rate-limited, validated.', status: 'pending' },
        {
          id: 'b-templates',
          title: 'Email templates',
          description: 'In your voice, with HTML escape.',
          status: 'pending',
        },
        { id: 'b-approval', title: 'Approval routing', description: 'One-time tokens, 72h expiry.', status: 'pending' },
        { id: 'b-jobs', title: 'Scheduling', description: 'Monday digest cron + reminders.', status: 'pending' },
        {
          id: 'b-sidecar',
          title: 'Observability sidecar',
          description: 'Captures every error and 5xx for self-heal.',
          status: 'pending',
        },
      ],
    },
    {
      id: 'testing',
      title: 'Test end-to-end',
      description: 'Synthetic submission → DB → email → approval → digest.',
      status:
        op.status === 'running' || op.status === 'deploying'
          ? status('completed')
          : op.status === 'testing'
          ? status('in-progress')
          : status('pending'),
      level: 3,
      dependencies: ['building'],
      subtasks: [],
    },
    {
      id: 'running',
      title: 'Deploy & operate',
      description: 'Live on Blaxel, healing itself when needed.',
      status: op.status === 'running' ? status('in-progress') : status('pending'),
      level: 4,
      dependencies: ['testing'],
      subtasks: [],
    },
  ];
}

// The empty state's three starters (AGENT-UX section 1, W2d): the generated
// pool when the store holds one for the connection's current schema shape,
// else the heuristic twelve; never a question already asked in ANY thread of
// the connection (the panel's set for the open thread, the thread titles for
// the ones not loaded); three cut from the connection's cursor, wrapping.
//
// The triple a mount shows is fixed at that mount: the store's cursor moves
// on by three so the NEXT show starts further along, and a re-render (a pool
// landing, a thread list arriving) never moves the cursor again. When the
// generated pool lands mid-view the three swap, so `key` changes and the
// empty state can crossfade on it. Mount here = mount of the empty state: the
// caller renders this hook only while the thread has no exchanges.

import { useEffect, useMemo, useRef } from "react";
import { schemaHash } from "../agent/starterPool";
import { modelChoice, useAgent } from "../stores/agent";
import type { SchemaSnapshot } from "../stores/schema";
import { useSettings } from "../stores/settings";
import { useStarterPools } from "../stores/starters";
import { questionKey, rotateStarters, starterPool } from "./starters";

const NO_THREADS: { title: string }[] = [];

export function useStarters(
  profileId: string,
  snapshot: SchemaSnapshot | undefined,
  asked: ReadonlySet<string>,
): { questions: string[]; key: string } {
  const pool = useStarterPools((s) => s.pools[profileId]);
  const cursor = useStarterPools((s) => s.cursors[profileId] ?? 0);
  const threads = useAgent((s) => s.threads[profileId]) ?? NO_THREADS;

  // the resolved provider/model, re-read whenever its inputs change (the
  // AskPanel shape); it decides only whether a pool can be generated
  const agentProvider = useSettings((s) => s.agentProvider);
  const agentModel = useSettings((s) => s.agentModel);
  const perConn = useSettings((s) => s.agentByConn[profileId]);
  const choice = useMemo(
    () => modelChoice(profileId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileId, agentProvider, agentModel, perConn],
  );

  const hash = useMemo(() => (snapshot ? schemaHash(snapshot) : null), [snapshot]);

  // where this show's triple starts: the cursor as it stood at mount, per
  // connection; the ref survives StrictMode's second effect pass, so the
  // cursor advances once per real show
  const startRef = useRef<{ profileId: string; start: number } | null>(null);
  const start = startRef.current?.profileId === profileId ? startRef.current.start : cursor;
  useEffect(() => {
    if (startRef.current?.profileId === profileId) return;
    const st = useStarterPools.getState();
    startRef.current = { profileId, start: st.cursors[profileId] ?? 0 };
    st.advance(profileId);
  }, [profileId]);

  useEffect(() => {
    useStarterPools.getState().ensurePool(profileId, snapshot, choice);
  }, [profileId, snapshot, choice]);

  const questions = useMemo(() => {
    const source =
      pool && hash !== null && pool.schemaHash === hash ? pool.questions : starterPool(snapshot, asked);
    const taken = new Set<string>();
    for (const q of asked) taken.add(questionKey(q));
    for (const t of threads) taken.add(questionKey(t.title));
    return rotateStarters(source, taken, start);
  }, [pool, hash, snapshot, asked, threads, start]);

  return { questions, key: questions.join("\n") };
}

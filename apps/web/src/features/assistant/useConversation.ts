import {useAutoDismiss} from '../../useAutoDismiss';
import {useEffect, useRef, useState} from 'react';
import type {Dispatch, SetStateAction} from 'react';
import {
  clearChatMessages, createNote, streamAnswer,
  type AgentProgress, type ChapterSummary, type ChatMessage, type CitationVerification,
  type DocumentRecord, type ModelProfile, type Note, type RagSource, type RagStatus, type WebSource,
} from '../../api';
import type {ensureFullDocumentIndex, RagIndexProgress} from '../../ragIndex';
import {useDocumentScope} from '../../shared/useDocumentScope';

type Message = Pick<ChatMessage, 'role' | 'content'> & {requestId?: symbol};
type Options = {
  activeDocument: DocumentRecord | null; documents: DocumentRecord[]; activeProfile: string; profiles: ModelProfile[];
  excerpt: string; currentPage: number; chapterSummaries: ChapterSummary[]; master: boolean;
  includeCurrentExcerpt: boolean; multiBookMode: boolean; selectedBookIds: string[];
  useWebVerification: boolean; deepAnswer: boolean; busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>; setError: (error: string) => void; onNoteSaved: (note: Note) => void;
};
type Dependencies = {stream: typeof streamAnswer; ensureIndex: typeof ensureFullDocumentIndex};
const defaults: Dependencies = {
  stream: streamAnswer,
  ensureIndex: async (...args) => (await import('../../ragIndex')).ensureFullDocumentIndex(...args),
};

export function useConversation(options: Options, dependencies: Dependencies = defaults) {
  const {activeDocument, documents, activeProfile, profiles, excerpt, currentPage, chapterSummaries, master,
    includeCurrentExcerpt, multiBookMode, selectedBookIds, useWebVerification, deepAnswer, busy, setBusy, setError, onNoteSaved} = options;
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [assistantMessages, setAssistantMessages] = useState<Message[]>([]);
  const [agentEvents, setAgentEvents] = useState<AgentProgress[]>([]);
  const [ragProgress, setRagProgress] = useState<RagIndexProgress | null>(null);
  const [indexingBookTitle, setIndexingBookTitle] = useState('');
  const [ragSources, setRagSources] = useState<RagSource[]>([]);
  const [ragStatus, setRagStatus] = useState<RagStatus | null>(null);
  const [webSources, setWebSources] = useState<WebSource[]>([]);
  const [citationVerification, setCitationVerification] = useState<CitationVerification | null>(null);
  const [verificationRunning, setVerificationRunning] = useState(false);
  useAutoDismiss(citationVerification?.warning, () => setCitationVerification(current => current ? {...current, warning: ''} : current));
  const capture = useDocumentScope(activeDocument?.id);
  const request = useRef<{controller: AbortController; valid: () => boolean} | null>(null);

  const resetEvidence = () => {
    setAgentEvents([]); setRagProgress(null); setRagSources([]); setRagStatus(null);
    setWebSources([]); setCitationVerification(null); setVerificationRunning(false); setIndexingBookTitle('');
  };
  useEffect(() => {
    setMessages([]); setAssistantMessages([]); setQuestion(''); resetEvidence(); setBusy(false);
    return () => {request.current?.controller.abort(); request.current = null;};
  }, [activeDocument?.id]);

  const runAsk = async (prompt: string) => {
    if (!prompt.trim() || !activeProfile || busy || request.current || !activeDocument) return;
    if (includeCurrentExcerpt && !excerpt.trim()) {setError('请选择或粘贴当前页原文，或者切换到单书全文模式。'); return;}
    const current = {controller: new AbortController(), valid: capture()};
    request.current = current;
    const owns = () => current.valid() && request.current === current;
    const accepting = () => owns() && !current.controller.signal.aborted;
    const conversation = master ? messages : assistantMessages;
    const update = master ? setMessages : setAssistantMessages;
    const user = {role: 'user' as const, content: prompt.trim()};
    const answerId = Symbol('answer');
    update(items => [...items, user, {role: 'assistant', content: '', requestId: answerId}]);
    setQuestion(''); setBusy(true); setError(''); resetEvidence();
    try {
      const ids = multiBookMode ? selectedBookIds : [activeDocument.id];
      if (!includeCurrentExcerpt) {
        if (!ids.length) throw new Error('请至少选择一本教材。');
        for (const id of ids) {
          if (!accepting()) return;
          setIndexingBookTitle(documents.find(item => item.id === id)?.title || '教材');
          await dependencies.ensureIndex(id, progress => {if (accepting()) setRagProgress(progress);}, current.controller.signal);
        }
      }
      if (!accepting()) return;
      setIndexingBookTitle('');
      const book = chapterSummaries.find(item => item.chapter_key === `${activeDocument.id}:__book__`);
      const context = includeCurrentExcerpt ? excerpt.trim() : book?.content.trim() ? `【全书知识结构】\n${book.content}`.slice(0, 12000) : '';
      await dependencies.stream({
        document_id: activeDocument.id, document_ids: !includeCurrentExcerpt ? ids : undefined,
        profile_id: activeProfile, excerpt: context, question: user.content, history: conversation.slice(-12).map(({role, content}) => ({role, content})),
        page_number: includeCurrentExcerpt ? currentPage : undefined,
        use_web: !includeCurrentExcerpt && useWebVerification, use_rag: !includeCurrentExcerpt,
        use_agent: !includeCurrentExcerpt && deepAnswer, verify_citations: !includeCurrentExcerpt, persist_history: master,
        max_tokens: includeCurrentExcerpt || deepAnswer ? undefined : Math.max(profiles.find(item => item.id === activeProfile)?.max_tokens || 2048, 8192),
      }, delta => {
        if (!accepting()) return;
        update(items => {
          // React may flush queued deltas after the request's finally block has run.
          // Target the answer, not the current request ref or the last list element.
          if (!current.valid() || current.controller.signal.aborted) return items;
          return items.map(item => item.requestId === answerId ? {...item, content: item.content + delta} : item);
        });
      }, current.controller.signal,
      (sources, status) => {if (accepting()) {setRagSources(sources); setRagStatus(status);}},
      (verification, running) => {if (accepting()) {setVerificationRunning(running); if (verification) setCitationVerification(verification);}},
      sources => {if (accepting()) setWebSources(sources);},
      progress => {if (accepting()) setAgentEvents(items => [...items.slice(-19), progress]);});
    } catch (error) {
      if (!owns()) return;
      if (current.controller.signal.aborted) {
        setAgentEvents(items => [...items, {stage: 'cancelled', message: '已取消本次问答，已停止后续调用；已显示的文字尚未完成核验。', model_calls: items.at(-1)?.model_calls || 0, max_model_calls: 4}]);
      } else {
        setError(error instanceof Error ? error.message : '模型请求失败');
        setAgentEvents(items => items.length ? [...items, {...items[items.length - 1], stage: 'error', message: '本次深度问答未完成，可重新发送问题重试。'}] : items);
      }
    } finally {
      if (owns()) {request.current = null; setVerificationRunning(false); setIndexingBookTitle(''); setBusy(false);}
    }
  };

  const cancelAsk = () => {
    const active = request.current;
    if (!active || !active.valid()) return;
    request.current = null;
    active.controller.abort();
    setVerificationRunning(false); setIndexingBookTitle(''); setBusy(false);
    setAgentEvents(items => [...items, {stage: 'cancelled', message: '已取消本次问答，已停止后续调用；已显示的文字尚未完成核验。', model_calls: items.at(-1)?.model_calls || 0, max_model_calls: 4}]);
  };

  const clearConversation = async () => {
    if (!activeDocument || !(master ? messages : assistantMessages).length) return;
    if (!master) {setAssistantMessages([]); return;}
    if (!window.confirm('确定清空当前教材的 Master 对话记录吗？')) return;
    const valid = capture();
    try {await clearChatMessages(activeDocument.id); if (valid()) setMessages([]);}
    catch (error) {if (valid()) setError(error instanceof Error ? error.message : '清空失败');}
  };
  const saveLastExplanation = async () => {
    if (!activeDocument) return;
    const answer = [...(master ? messages : assistantMessages)].reverse().find(item => item.role === 'assistant' && item.content.trim());
    if (!answer) return;
    const valid = capture();
    try {
      const note = await createNote(activeDocument.id, {page_number: currentPage, excerpt: excerpt.trim(), content: answer.content, title: 'AI 阅读辅助', tags: ['AI', '阅读辅助'], pinned: false});
      if (valid()) onNoteSaved(note);
    } catch (error) {if (valid()) setError(error instanceof Error ? error.message : '解释保存失败');}
  };
  return {question, setQuestion, messages, setMessages, assistantMessages, agentEvents, ragProgress, indexingBookTitle,
    ragSources, ragStatus, webSources, citationVerification, verificationRunning, runAsk,
    ask: () => runAsk(question), cancelAsk, clearConversation, saveLastExplanation};
}

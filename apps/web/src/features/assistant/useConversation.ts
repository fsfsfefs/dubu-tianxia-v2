import {useAutoDismiss} from '../../useAutoDismiss';
import {useEffect, useRef, useState} from 'react';
import type {Dispatch, SetStateAction} from 'react';
import {
  clearChatMessages, createNote, streamAnswer, listSavedChats, writeSavedChat, type SavedChat,
  type AgentProgress, type ChapterSummary, type ChatMessage, type CitationVerification,
  type DocumentRecord, type ModelProfile, type Note, type RagSource, type RagStatus, type WebSource,
} from '../../api';
import type {ensureFullDocumentIndex, RagIndexProgress} from '../../ragIndex';
import {useDocumentScope} from '../../shared/useDocumentScope';

type Message = Pick<ChatMessage, 'role' | 'content'> & {requestId?: symbol};
type Options = {
  saveChats?: boolean; activeDocument: DocumentRecord | null; documents: DocumentRecord[]; activeProfile: string; profiles: ModelProfile[];
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
  const [images, setImages] = useState<{name: string; url: string}[]>([]);
  const [imageBusy, setImageBusy] = useState(false);
  const imageRead = useRef<object | null>(null);
  const addImages = async (files: File[]) => {
    if (busy || imageRead.current) return;
    if (files.length + images.length > 4) {setError('最多附加4张图片。'); return;}
    if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 20 * 1024 * 1024)) {
      setError('请选择PNG、JPEG或WebP图片，每张不超过20MB。'); return;
    }
    const valid = capture();
    const token = {};
    imageRead.current = token; setImageBusy(true);
    try {
      const added = await Promise.all(files.map(file => new Promise<{name: string; url: string}>((resolve, reject) => {
        const reader = new window.FileReader();
        reader.onload = () => resolve({name: file.name || '粘贴图片', url: String(reader.result)});
        reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
        reader.readAsDataURL(file);
      })));
      if (valid() && imageRead.current === token) {setImages(items => [...items, ...added]); setError('');}
    } catch (error) {if (valid()) setError(error instanceof Error ? error.message : '图片读取失败');}
    finally {if (valid() && imageRead.current === token) {imageRead.current = null; setImageBusy(false);}}
  };
  const removeImage = (index: number) => {if (!busy && !imageBusy) setImages(items => items.filter((_, i) => i !== index));};
  const pasteImages = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
    if (files.length) {event.preventDefault(); void addImages(files);}
  };
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
    setMessages([]); setAssistantMessages([]); setQuestion(''); setImages([]); setImageBusy(false); imageRead.current = null; resetEvidence(); setBusy(false);
    return () => {request.current?.controller.abort(); request.current = null;};
  }, [activeDocument?.id]);

  const [chats,setChats]=useState<SavedChat[]>([]),[chatReady,setChatReady]=useState(!options.saveChats),[chatWorking,setChatWorking]=useState(false),[chatNotice,setChatNotice]=useState('');
  const selectedChat=useRef<SavedChat|null>(null),chatVisit=useRef<object>({}),savedText=useRef(''),saveQueue=useRef<Promise<unknown>>(Promise.resolve());
  const kind=master?'master':'chat';
  const visibleMessages=master?messages:assistantMessages;
  const signature=(items:Message[])=>JSON.stringify(items.map(({role,content})=>({role,content})));
  const activateChat=(chat:SavedChat)=>{
    selectedChat.current=chat;savedText.current=signature(chat.messages);imageRead.current=null;setImageBusy(false);
    (master?setMessages:setAssistantMessages)(chat.messages);setImages([]);setQuestion('');resetEvidence();setChatNotice('');
  };
  useEffect(()=>{
    if(!options.saveChats)return;
    const visit={};chatVisit.current=visit;selectedChat.current=null;setChatReady(false);setChatWorking(false);setChats([]);setChatNotice('');request.current?.controller.abort();request.current=null;setBusy(false);
    if(!activeDocument)return;
    const doc=activeDocument.id;
    void listSavedChats(doc).then(async items=>{
      if(chatVisit.current!==visit)return;
      let chosen=items.find(item=>item.kind===kind);
      if(!chosen){chosen=await writeSavedChat(doc,{title:'新聊天',kind,messages:[],revision:0});items=[chosen,...items];}
      if(chatVisit.current!==visit)return;
      setChats(items);activateChat(chosen);setChatReady(true);
    }).catch(error=>{if(chatVisit.current===visit)setError(error.message);});
    return ()=>{chatVisit.current={};request.current?.controller.abort();request.current=null;};
  },[activeDocument?.id,master,options.saveChats]);
  const saveChat=async(title?:string)=>{
    const current=selectedChat.current,visit=chatVisit.current;
    if(!current || !activeDocument)return;
    const doc=activeDocument.id,items=visibleMessages.map(({role,content})=>({role,content})),text=signature(items);
    const name=title || (current.title==='新聊天'&&items.length?items[0].content.slice(0,30)||'图片提问':current.title);
    const operation=saveQueue.current.catch(()=>{}).then(async()=>{
      if(chatVisit.current!==visit)return;
      if(text===savedText.current && name===selectedChat.current?.title)return;
      const fresh=selectedChat.current;
      if(!fresh || fresh.id!==current.id)return;
      const result=await writeSavedChat(doc,{title:name,kind:current.kind,messages:items,revision:fresh.revision},current.id);
      if(chatVisit.current!==visit || selectedChat.current?.id!==current.id)return;
      selectedChat.current=result;savedText.current=text;setChats(all=>all.map(item=>item.id===result.id?result:item));setChatNotice('已保存');
    });
    saveQueue.current=operation;await operation;
  };
  useEffect(()=>{
    if(!options.saveChats || !chatReady || busy || chatWorking)return;
    void saveChat().catch(error=>setError(error.message));
  },[messages,assistantMessages,busy,chatReady,chatWorking]);
  const changeChat=async(id?:string)=>{
    if(!activeDocument || busy || chatWorking || !chatReady)return;
    const visit=chatVisit.current;setChatWorking(true);
    try{
      await saveChat();if(chatVisit.current!==visit)return;
      const chat=id?chats.find(item=>item.id===id):await writeSavedChat(activeDocument.id,{title:'新聊天',kind,messages:[],revision:0});
      if(!chat || chatVisit.current!==visit)return;
      if(!id)setChats(items=>[chat,...items]);activateChat(chat);
    }catch(error){if(chatVisit.current===visit)setError(error instanceof Error?error.message:'聊天切换失败');}
    finally{if(chatVisit.current===visit)setChatWorking(false);}
  };
  const renameChat=async()=>{
    if(!selectedChat.current || busy || chatWorking)return;
    const title=window.prompt('聊天名称',selectedChat.current.title)?.trim();
    if(!title)return;
    try{await saveChat(title);}catch(error){setError(error instanceof Error?error.message:'命名失败');}
  };

  const runAsk = async (prompt: string) => {
    if (options.saveChats && (!chatReady || chatWorking))return;
    if ((!prompt.trim() && !images.length) || !activeProfile || busy || imageBusy || imageRead.current || request.current || !activeDocument) return;
    if (includeCurrentExcerpt && !excerpt.trim() && !images.length) {setError('请选择或粘贴当前页原文，或者切换到单书全文模式。'); return;}
    const current = {controller: new AbortController(), valid: capture()};
    request.current = current;
    const owns = () => current.valid() && request.current === current;
    const accepting = () => owns() && !current.controller.signal.aborted;
    const conversation = master ? messages : assistantMessages;
    const update = master ? setMessages : setAssistantMessages;
    const user = {role: 'user' as const, content: prompt.trim() || '请解读附图中的教材内容或问题。'};
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
        profile_id: activeProfile, excerpt: context, images: images.length ? images.map(image => image.url) : undefined, question: user.content, history: conversation.slice(-12).map(({role, content}) => ({role, content})),
        page_number: includeCurrentExcerpt ? currentPage : undefined,
        use_web: !includeCurrentExcerpt && useWebVerification, use_rag: !includeCurrentExcerpt,
        use_agent: !includeCurrentExcerpt && deepAnswer, verify_citations: !includeCurrentExcerpt, persist_history: options.saveChats ? false : master,
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
        setAgentEvents(items => items.length ? [...items, {...items[items.length - 1], stage: 'error', message: '本次问答未完成，可重新发送问题重试。'}] : items);
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
    if(options.saveChats){if(window.confirm('清空当前聊天内容？其他历史聊天不受影响。'))(master?setMessages:setAssistantMessages)([]);return;}
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
  return {chats, chatReady, chatWorking, chatNotice, selectedChatId:selectedChat.current?.id || '', newChat:()=>changeChat(), switchChat:changeChat, saveChat:async()=>{try{await saveChat();}catch(error){setError(error instanceof Error?error.message:'保存失败');}}, renameChat, images, imageBusy, addImages, removeImage, pasteImages, question, setQuestion, messages, setMessages, assistantMessages, setAssistantMessages, agentEvents, ragProgress, indexingBookTitle,
    ragSources, ragStatus, webSources, citationVerification, verificationRunning, runAsk,
    ask: () => runAsk(question), cancelAsk, clearConversation, saveLastExplanation};
}

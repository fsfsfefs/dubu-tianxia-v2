import {useState} from 'react';
import type {DocumentRecord} from '../../api';
type Screen = 'home' | 'overview' | 'reader' | 'memory';
type NavigationEntry = {
  screen: Screen;
  documentId: string | null;
  currentPage: number;
  memoryBookOpen: boolean;
  memoryMode: 'body' | 'practice';
  assistantOpen: boolean;
};

export function useWorkspaceNavigation(documents: DocumentRecord[]) {
  const [screen, setScreen] = useState<Screen>('home');
  const [navigationStack, setNavigationStack] = useState<NavigationEntry[]>([]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [memoryBookOpen, setMemoryBookOpen] = useState(false);
  const [memoryMode, setMemoryMode] = useState<'body' | 'practice'>('body');
  const [activeDocument, setActiveDocument] = useState<DocumentRecord | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [readerPageRevision, setReaderPageRevision] = useState(0);
  const [readerRestorePosition, setReaderRestorePosition] = useState(true);
  const rememberCurrentPage = () => setNavigationStack(items => [...items, {
    screen,
    documentId: activeDocument?.id || null,
    currentPage,
    memoryBookOpen,
    memoryMode,
    assistantOpen,
  }].slice(-50));
  const navigateTo = (
    nextScreen: Screen,
    options: {document?: DocumentRecord; page?: number; memoryBookOpen?: boolean; assistantOpen?: boolean} = {},
  ) => {
    const nextDocument = options.document || activeDocument;
    const nextPage = options.page || currentPage;
    const nextMemoryBookOpen = options.memoryBookOpen ?? memoryBookOpen;
    const nextAssistantOpen = options.assistantOpen ?? (nextScreen === 'reader' ? assistantOpen : false);
    if (nextScreen === screen && nextDocument?.id === activeDocument?.id && nextPage === currentPage
      && nextMemoryBookOpen === memoryBookOpen && nextAssistantOpen === assistantOpen) return;
    rememberCurrentPage();
    if (options.document) setActiveDocument(options.document);
    if (options.page) setCurrentPage(options.page);
    setMemoryBookOpen(nextMemoryBookOpen);
    setAssistantOpen(nextAssistantOpen);
    setScreen(nextScreen);
  };
  const goBack = () => {
    const previous = navigationStack[navigationStack.length - 1];
    if (!previous) return;
    setNavigationStack(items => items.slice(0, -1));
    const previousDocument = previous.documentId ? documents.find(item => item.id === previous.documentId) : null;
    setActiveDocument(previousDocument || documents[0] || null);
    setCurrentPage(previous.currentPage);
    setMemoryBookOpen(previous.memoryBookOpen);
    setMemoryMode(previous.memoryMode);
    setAssistantOpen(previous.assistantOpen);
    setScreen(previous.screen);
  };
  const openBook = (document: DocumentRecord) => navigateTo('overview', {document, memoryBookOpen: false, assistantOpen: false});
  const enterReader = (document = activeDocument, page?: number) => {
    if (!document) return;
    if (screen === 'reader' && activeDocument?.id === document.id && page) {
      setReaderRestorePosition(false);
      setCurrentPage(page);
      setReaderPageRevision(value => value + 1);
      return;
    }
    setReaderRestorePosition(page === undefined);
    navigateTo('reader', {document, page, assistantOpen});
  };
  const requestReaderPage = (page: number) => {
    setReaderRestorePosition(false);
    setCurrentPage(page);
    setReaderPageRevision(value => value + 1);
  };
  const openMemory = () => navigateTo('memory', {memoryBookOpen: false, assistantOpen: false});
  const openMemoryBook = (document: DocumentRecord) => navigateTo('memory', {document, memoryBookOpen: true, assistantOpen: false});
  return {screen, setScreen, navigationStack, setNavigationStack, assistantOpen, setAssistantOpen, memoryBookOpen, setMemoryBookOpen, memoryMode, setMemoryMode, activeDocument, setActiveDocument, currentPage, setCurrentPage, readerPageRevision, setReaderPageRevision, readerRestorePosition, setReaderRestorePosition, rememberCurrentPage, navigateTo, goBack, openBook, enterReader, requestReaderPage, openMemory, openMemoryBook};
}

import {useEffect, useRef} from 'react';

/** Ignore work from an older book visit, including A → B → A and unmount. */
export function useDocumentScope(documentId: string | undefined) {
  const scope = useRef({documentId, generation: 0, mounted: true});
  if (scope.current.documentId !== documentId) {
    scope.current = {...scope.current, documentId, generation: scope.current.generation + 1};
  }
  useEffect(() => {
    scope.current.mounted = true;
    return () => {scope.current.mounted = false; scope.current.generation++;};
  }, []);
  return () => {
    const generation = scope.current.generation;
    return () => scope.current.mounted && scope.current.generation === generation;
  };
}

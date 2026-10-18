type IconName = 'shield' | 'import' | 'arrow' | 'check' | 'copy' | 'settings' | 'close' | 'chevron' | 'undo' | 'redo' | 'file';

const paths: Record<IconName, string> = {
  settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  close: 'm6 6 12 12M6 18 18 6',
  chevron: 'm9 5 7 7-7 7',
  undo: 'M9 5 4 10l5 5M4 10h9a6 6 0 0 1 6 6v3',
  redo: 'm15 5 5 5-5 5M20 10h-9a6 6 0 0 0-6 6v3',
  shield: 'M12 3 4 6v6c0 4.5 8 9 8 9s8-4.5 8-9V6l-8-3ZM9 12l2 2 4-4',
  import: 'M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  check: 'm5 12 4 4L19 6',
  copy: 'M9 9h11v12H9zM15 5V3H4v12h2',
  file: 'M14 3H6v18h12V7l-4-4Zm0 0v4h4M9 12h6m-6 4h6',
};

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg className={`icon ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

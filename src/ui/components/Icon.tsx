type IconName = 'shield' | 'import' | 'arrow' | 'check' | 'copy';

const paths: Record<IconName, string> = {
  shield: 'M12 3 4 6v6c0 4.5 8 9 8 9s8-4.5 8-9V6l-8-3ZM9 12l2 2 4-4',
  import: 'M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  check: 'm5 12 4 4L19 6',
  copy: 'M9 9h11v12H9zM15 5V3H4v12h2',
};

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg className={`icon ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

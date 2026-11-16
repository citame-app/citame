/** Plain fragment links keep long settings forms mounted, including unsaved drafts. */
export function SectionIndex({
  label,
  items,
}: {
  label: string;
  items: readonly { id: string; label: string }[];
}) {
  return (
    <nav aria-label={label} className="section-index">
      {items.map((item) => (
        <a key={item.id} href={`#${item.id}`}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}

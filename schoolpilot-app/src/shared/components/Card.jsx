export default function Card({ children, className = '', ...props }) {
  return (
    <div
      className={`rounded-lg border border-border bg-card text-card-foreground p-4 shadow-sm ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

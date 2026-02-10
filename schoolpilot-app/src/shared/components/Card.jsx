export default function Card({ children, className = '', ...props }) {
  return (
    <div
      className={`rounded-lg border border-slate-200 bg-white p-4 shadow-sm ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

// Shared GoPilot UI primitives (light theme).
//
// Extracted from the previously duplicated inline copies in ParentOnboarding
// and TeacherView. ParentApp and DismissalDashboard intentionally keep their
// own inline kits: ParentApp's uses different spacing/radii (gap-1 badges,
// rounded-xl buttons, rounded-2xl cards) and DismissalDashboard's is
// dark-mode aware, so folding them in here would change their rendering.

export const Badge = ({ children, variant = 'default', size = 'md', pulse = false }) => {
  const variants = {
    default: 'bg-gray-100 text-gray-800',
    blue: 'bg-blue-100 text-blue-800',
    green: 'bg-green-100 text-green-800',
    yellow: 'bg-yellow-100 text-yellow-800',
    red: 'bg-red-100 text-red-800',
    purple: 'bg-purple-100 text-purple-800',
  };
  const sizes = { sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-1 text-sm' };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-medium ${variants[variant]} ${sizes[size]} ${pulse ? 'animate-pulse' : ''}`}>
      {children}
    </span>
  );
};

export const Button = ({ children, variant = 'primary', size = 'md', onClick, disabled, className = '', type = 'button' }) => {
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300',
    secondary: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50',
    success: 'bg-green-600 text-white hover:bg-green-700',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    warning: 'bg-yellow-500 text-white hover:bg-yellow-600',
    ghost: 'text-gray-600 hover:bg-gray-100',
  };
  const sizes = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-sm', lg: 'px-6 py-3 text-base' };
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors ${variants[variant]} ${sizes[size]} ${className} disabled:cursor-not-allowed`}>
      {children}
    </button>
  );
};

export const Card = ({ children, className = '', onClick }) => (
  <div
    className={`bg-white rounded-xl shadow-sm border border-gray-200 ${onClick ? 'cursor-pointer hover:shadow-md transition-shadow' : ''} ${className}`}
    onClick={onClick}
  >
    {children}
  </div>
);

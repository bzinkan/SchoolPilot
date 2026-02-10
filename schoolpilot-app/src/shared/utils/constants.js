export const PRODUCTS = {
  CLASSPILOT: 'CLASSPILOT',
  PASSPILOT: 'PASSPILOT',
  GOPILOT: 'GOPILOT',
};

export const PRODUCT_CONFIG = {
  CLASSPILOT: {
    key: 'CLASSPILOT',
    label: 'ClassPilot',
    color: 'yellow',
    bgClass: 'bg-yellow-50',
    textClass: 'text-yellow-700',
    borderClass: 'border-yellow-400',
    accentClass: 'bg-yellow-500',
    icon: '🖥️',
    basePath: '/classpilot',
  },
  PASSPILOT: {
    key: 'PASSPILOT',
    label: 'PassPilot',
    color: 'purple',
    bgClass: 'bg-purple-50',
    textClass: 'text-purple-700',
    borderClass: 'border-purple-400',
    accentClass: 'bg-purple-500',
    icon: '🎫',
    basePath: '/passpilot',
  },
  GOPILOT: {
    key: 'GOPILOT',
    label: 'GoPilot',
    color: 'blue',
    bgClass: 'bg-blue-50',
    textClass: 'text-blue-700',
    borderClass: 'border-blue-400',
    accentClass: 'bg-blue-500',
    icon: '🚗',
    basePath: '/gopilot',
  },
};

// Priority order for default product routing
export const PRODUCT_PRIORITY = ['CLASSPILOT', 'PASSPILOT', 'GOPILOT'];

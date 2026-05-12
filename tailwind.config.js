/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ink: '#1a1814',
        paper: '#f4efe6',
        paper2: '#ebe4d6',
        accent: '#c8341e',
        accent2: '#1e5b3a',
        gold: '#b8881c',
        muted: '#6b6358',
      },
      fontFamily: {
        sans: ['"Zen Kaku Gothic New"', 'system-ui', 'sans-serif'],
        mincho: ['"Shippori Mincho"', 'serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        ink: '4px 4px 0 #1a1814',
        inkSm: '2px 2px 0 #1a1814',
      },
    },
  },
  plugins: [],
};

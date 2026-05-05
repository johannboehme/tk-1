/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Bricolage Grotesque Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
        sans: ['"Geist Variable"', "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        // Studio Console — warm paper / LCD-black / hot orange
        paper: {
          DEFAULT: "#F2EDE2",
          deep: "#E8E1D0",
          hi: "#FAF6EC",
          panel: "#DDD4BE",
        },
        sunken: {
          DEFAULT: "#1A1816",
          soft: "#2A2722",
        },
        ink: {
          DEFAULT: "#1A1816",
          // legacy aliases so old pages (Login, Upload, etc.) keep working
          900: "#1A1816",
          800: "#2A2722",
          700: "#3A352E",
          600: "#5C544A",
          500: "#9A8F80",
          2: "#5C544A",
          3: "#9A8F80",
          inverse: "#F2EDE2",
        },
        rule: {
          DEFAULT: "#C9BFA6",
          soft: "#D8CFB8",
        },
        hot: {
          DEFAULT: "#FF5722",
          pressed: "#E04A1C",
          soft: "#FFE3D6",
        },
        cobalt: {
          DEFAULT: "#1F4E8C",
          soft: "#D6E0EE",
        },
        // legacy "accent" → maps to hot orange so old TopBar/etc. don't look broken
        accent: {
          400: "#FF7A4F",
          500: "#FF5722",
          600: "#E04A1C",
        },
        success: "#2A8A4A",
        warn: "#E5A100",
        danger: "#C0392B",
      },
      borderRadius: {
        pill: "999px",
      },
      boxShadow: {
        emboss:
          "0 1px 0 rgba(255,255,255,0.6) inset, 0 -1px 0 rgba(0,0,0,0.06) inset, 0 1px 2px rgba(0,0,0,0.06)",
        pressed:
          "0 1px 1px rgba(0,0,0,0.18) inset, 0 -1px 0 rgba(0,0,0,0.08) inset",
        panel:
          "0 1px 0 rgba(255,255,255,0.5) inset, 0 1px 2px rgba(0,0,0,0.05)",
        lcd:
          "0 1px 1px rgba(255,255,255,0.5), 0 1px 2px rgba(0,0,0,0.4) inset",
        knob:
          "0 6px 12px -4px rgba(0,0,0,0.25), 0 2px 4px -1px rgba(0,0,0,0.15), 0 1px 0 rgba(255,255,255,0.7) inset",
        "knob-pressed":
          "0 2px 4px -2px rgba(0,0,0,0.25), 0 1px 0 rgba(255,255,255,0.5) inset",
        hot: "0 4px 8px -2px rgba(255,87,34,0.45)",
      },
      backgroundImage: {
        "paper-grain":
          "radial-gradient(circle at 1px 1px, rgba(154,143,128,0.15) 1px, transparent 0)",
      },
      backgroundSize: {
        grain: "8px 8px",
      },
      letterSpacing: {
        label: "0.16em",
      },
      keyframes: {
        "cockpit-scan": {
          "0%": { left: "0%", opacity: "0" },
          "15%": { opacity: "0.9" },
          "85%": { opacity: "0.9" },
          "100%": { left: "100%", opacity: "0" },
        },
        "frame-pulse": {
          "0%, 100%": {
            filter: "drop-shadow(0 0 4px rgba(255,87,34,0.45))",
          },
          "50%": {
            filter: "drop-shadow(0 0 10px rgba(255,87,34,0.75))",
          },
        },
      },
      animation: {
        "cockpit-scan": "cockpit-scan 4s linear infinite",
        "frame-pulse": "frame-pulse 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

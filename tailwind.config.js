/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./app.js"],
  theme: {
    extend: {
      colors: {
        ink: "#183043",
        teal: { 50: "#eef9f7", 100: "#d7f0eb", 500: "#2a9d8f", 600: "#218779", 700: "#1c6e64" },
        sand: { 50: "#fbfaf7", 100: "#f2efe8" }
      },
      boxShadow: { soft: "0 14px 40px rgba(32, 58, 69, .07)" },
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"] }
    }
  },
  plugins: []
};

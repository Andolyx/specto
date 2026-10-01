const colors = require("tailwindcss/colors");
const defaultTheme = require("tailwindcss/defaultTheme");

/**
 * @type {import("tailwindcss").Config}
 */
module.exports = {
  content: ["src/**/*.{js,ts,tsx}"],
  darkMode: "class",
  theme: {
    colors: {
      current: colors.current,
      white: colors.white,
      black: colors.black,
      transparent: colors.transparent,
      neutral: colors.neutral,
      brand: {
        50: "#effee7",
        100: "#dcfdc8",
        200: "#bafb94",
        300: "#8ffa5a",
        400: "#6efb33",
        500: "#53fc18",
        600: "#3fcf0c",
        700: "#2f8f0a",
        800: "#24700b",
        900: "#1c5c0a",
        950: "#0b3302",
      },
      red: colors.red,
    },
    extend: {
      fontFamily: {
        sans: ["Noto Sans Display", ...defaultTheme.fontFamily.sans],
      },
    },
  },
};

// Stands in for regenerator-runtime, which tesseract.js loads for browsers
// without async functions. Every browser YDM supports has them; the
// polyfill's fallback uses the Function constructor, which an extension
// should not ship. (Aliased in wxt.config.ts.)
export {};

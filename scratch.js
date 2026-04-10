const apiKey = process.env.GEMINI_API_KEY || "";
const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash?key=${apiKey}`;
fetch(url)
  .then(r => r.json())
  .then(console.log)
  .catch(console.error);

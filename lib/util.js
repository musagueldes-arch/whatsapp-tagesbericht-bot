function pad2(n) {
  return String(n).padStart(2, '0');
}

function todayStr() {
  const d = new Date();
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

module.exports = { todayStr };

const checks = [];
for (let i = 0; i < 90; i++) checks.push(`check-${String(i).padStart(2, "0")}`);
const failing = checks[(17 * 5 + 3 * 18 + 9) % 90];
for (let round = 1; round <= 40; round++) {
  for (const name of checks) {
    const failed = name === failing && round === 29;
    const status = failed ? "FAILED" : round % 13 === 0 ? "WARN" : "PASSED";
    console.log(`round=${round} check=${name} status=${status}`);
  }
}

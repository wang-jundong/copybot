// UTC timestamp at the moment each line is written.
export function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

export function logError(...parts) {
  console.error(new Date().toISOString(), ...parts);
}

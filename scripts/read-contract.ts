import { CONTRACTS } from "@tisty/contracts";

interface Said {
  group: string;
  enums?: Record<string, unknown>;
}

interface Whole {
  contracts: Record<string, unknown>;
  enums: Record<string, unknown>;
}

const OPENS = "const WHOLE = ";
const CLOSES = ";\n";

const tasks = Object.entries(CONTRACTS as unknown as Record<string, Said>).filter(([, { group }]) => group === "tasks");

// Its additional permission lets a build leave out what it does not use, and no reader opens a task.
export const withoutTasks = (code: string): string => {
  const ends = code.indexOf(CLOSES);
  if (!code.startsWith(OPENS) || ends === -1) throw new Error("the contract's check is not written as it was");
  const whole = JSON.parse(code.slice(OPENS.length, ends)) as Whole;
  for (const [name, { enums = {} }] of tasks) {
    delete whole.contracts[name];
    for (const one of Object.keys(enums)) delete whole.enums[one];
  }
  return `${OPENS}${JSON.stringify(whole)}${code.slice(ends)}`;
};

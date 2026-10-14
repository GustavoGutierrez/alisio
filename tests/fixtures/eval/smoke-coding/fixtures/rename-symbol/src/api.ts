export interface User {
  id: number;
  name: string;
}

const USERS: User[] = [
  { id: 1, name: "Ada" },
  { id: 2, name: "Linus" },
  { id: 3, name: "Grace" },
];

/** Looks a user up by id. */
export function fetchUser(id: number): User | undefined {
  return USERS.find((user) => user.id === id);
}

/** Looks a user up by exact name. */
export function fetchUserByName(name: string): User | undefined {
  return USERS.find((user) => user.name === name);
}

/** Lists every user. */
export function fetchUsers(): User[] {
  return [...USERS];
}

if (
  process.env.CI === "true" ||
  process.env.HUSKY === "0" ||
  process.env.NODE_ENV === "production"
) {
  process.exit(0);
}

const husky = (await import("husky")).default;

console.log(husky());

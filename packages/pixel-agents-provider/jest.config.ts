module.exports = {
  verbose: true,
  transform: { "^.+\\.ts$": "ts-jest" },
  testEnvironment: "node",
  testRegex: "/test/.*\\.(test|spec)\\.ts$",
  moduleFileExtensions: ["ts", "js", "json", "node"],
  collectCoverage: false,
  collectCoverageFrom: ["src/**/*.ts"],
};

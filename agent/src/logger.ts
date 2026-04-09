export type LogLevel = "info" | "warn" | "error" | "debug";

export class Logger {
  private service: string;

  constructor(service: string) {
    this.service = service;
  }

  private log(level: LogLevel, message: string, meta?: Record<string, any>) {
    const entry = {
      timestamp: new Date().toISOString(),
      service: this.service,
      level,
      message,
      ...meta
    };

    console.log(JSON.stringify(entry));
  }

  info(message: string, meta?: Record<string, any>) {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, any>) {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: Record<string, any>) {
    this.log("error", message, meta);
  }

  debug(message: string, meta?: Record<string, any>) {
    this.log("debug", message, meta);
  }
}

import Bull from "bull";
import dotenv from "dotenv";

dotenv.config();
let redisOptions;

if (process.env.NODE_ENV === "development") {
    // Use Redis Cloud for development
    redisOptions = {
        host: process.env.REDIS_HOST,     // e.g., your cloud host
        port: Number(process.env.REDIS_PORT), // usually 6379
        password: process.env.REDIS_PASSWORD
    };
} else {
    // Use local Redis in production
    redisOptions = { host: "127.0.0.1", port: 6379 };
}

export const scrapeQueue = new Bull("trustedtrader-scraper", { redis: redisOptions });

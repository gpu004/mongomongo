import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { MongoClient } from "mongodb";

/**
 * MongoDB for tests. Uses HORIZON_TEST_MONGODB_URI when set (an Atlas
 * development cluster or any replica set); otherwise starts a throwaway
 * single-node replica set in Docker (image mongo:8.0) and stops it afterwards.
 * Returns undefined when neither is possible so callers can skip honestly.
 */
export interface MongoFixture {
  uri: string;
  stop(): Promise<void>;
}

const IMAGE = "mongo:8.0";

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
  return r.status === 0;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function startMongo(): Promise<MongoFixture | undefined> {
  const external = process.env.HORIZON_TEST_MONGODB_URI;
  if (external) return { uri: external, stop: async () => {} };
  if (process.env.HORIZON_SKIP_DOCKER_TESTS === "1" || !dockerAvailable()) return undefined;
  const name = `horizon-test-mongo-${randomUUID().slice(0, 8)}`;
  // The replica-set member must be addressable by the same host:port from inside and outside
  // the container, so mongod listens on the host port itself.
  const port = await freePort();
  try {
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "-p",
        `127.0.0.1:${port}:${port}`,
        IMAGE,
        "--replSet",
        "rs0",
        "--port",
        String(port),
        "--bind_ip_all",
      ],
      { stdio: "pipe", timeout: 120_000 },
    );
  } catch {
    return undefined;
  }
  const stop = async () => {
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 });
  };
  const uri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2_000 });
    try {
      await client.connect();
      const hello = (await client.db("admin").command({ hello: 1 })) as {
        setName?: string;
        isWritablePrimary?: boolean;
      };
      if (!hello.setName) {
        await client.db("admin").command({
          replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `127.0.0.1:${port}` }] },
        });
      } else if (hello.isWritablePrimary) {
        return { uri, stop };
      }
    } catch (error) {
      lastError = error;
    } finally {
      await client.close();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error(`mongo replica set did not become primary: ${String(lastError)}`);
}

import axios from "axios";
import http from "http";
import https from "https";

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const client = axios.create({
  httpAgent,
  httpsAgent,
  timeout: 15000,
});

export async function fetchData<T>(url: string): Promise<T> {
  try {
    const response = await client.get<T>(url);
    return response.data;
  } catch (error) {
    const logger = require('./logger').default;
    logger.error(`Error fetching data from ${url}:`, error);
    throw error;
  }
}

export async function postData<T, R>(url: string, data: T): Promise<R> {
  try {
    const response = await client.post<R>(url, data);
    return response.data;
  } catch (error) {
    const logger = require('./logger').default;
    logger.error(`Error posting data to ${url}:`, error);
    throw error;
  }
}

export default fetchData;

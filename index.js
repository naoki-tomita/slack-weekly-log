const { WebClient } = require("@slack/web-api");
const { Parser } = require("json2csv");
const { writeFile } = require("fs");
const { format, addDays, addMinutes } = require("date-fns");
const CHANNELS = require("./channels.json");

const writeFileAsync = async (path, data) =>
  new Promise((ok, ng) => writeFile(path, data, e => e ? ng(e): ok()));


function includes(it, channels) {
  return (
    channels.some(name => it.name === name) ||
    channels.some(name => it.name_normalized === name) ||
    it.previous_names.some(it => channels.some(name => it === name))
  );
}

function toCsv(channels, headers) {
  const json2csvParser = new Parser({ fields: headers, delimiter: "\t" });
  return json2csvParser.parse(channels);
}

class User {
  /**
   * @param {string} id
   * @param {string} name
   */
  constructor(id, name) {
    this.id = id;
    this._name = name;
  }

  get name() {
    return `@${this._name}`;
  }
}

class Message {
  /**
   * @param {string} text
   * @param {Date} timestamp
   */
  constructor(text, timestamp) {
    this.text = text;
    this.timestamp = timestamp;
  }
}

class Messages {
  /**
   * @param {Message[]} list
   * @param {Date} oldest
   */
  constructor(list, oldest) {
    this.list = list;
    this.oldest = oldest;
  }

  get length() {
    return this.list.length;
  }

  /**
   *
   * @param {Date} weekend
   */
  getListOneWeek(weekend) {
    return this.filter(it => Dates.isDateBetweenInterval(it.timestamp, addDays(weekend, -7), weekend));
  }

  map(predicate) {
    return new Messages(this.list.map(predicate), this.oldest);
  }

  /**
   * @param {(message: Message) => boolean} predicate
   */
  filter(predicate) {
    return new Messages(this.list.filter(predicate), this.oldest);
  }
}

class Dates {
  /**
   *
   * @param {Date} from
   * @param {Date} to
   */
  static createDatesWith7DaysIntervals(from, to) {
    const fromTime = from.getTime();
    const firstWeekEnd = addMinutes(addDays(from, 6 - from.getDay()), -1);
    const toTime = to.getTime();
    const weekTime = 7 * 24 * 60 * 60 * 1000;
    const weekCountFromNewYearToNow = Math.floor(((toTime - fromTime) / weekTime) + 1);
    return Array(weekCountFromNewYearToNow).fill(null).map((_, i) => new Date(firstWeekEnd.getTime() + (i * weekTime)));
  }

  /**
   *
   * @param {Date} date
   * @param {Date} start
   * @param {Date} end
   */
  static isDateBetweenInterval(date, start, end) {
    return start.getTime() < date.getTime() && date.getTime() < end.getTime();
  }
}

class Channel {
  /**
   * @param {string} id
   * @param {string} name
   * @param {User} owner
   * @param {Messages} messages
   */
  constructor(id, name, owner, messages) {
    this.id = id;
    this._name = name;
    this.owner = owner;
    this.messages = messages;
  }

  get name() {
    return `#${this._name}`;
  }

  formatDate(date) {
    return `〜${format(date, "yyyyMMdd")}`
  }

  toJson() {
    const { id, name, owner } = this;
    const dates = Dates.createDatesWith7DaysIntervals(this.messages.oldest, new Date());
    const messageCountWithDate = dates.reduce((prev, week) =>
      ({ ...prev, [this.formatDate(week)]: this.messages.getListOneWeek(week).length }), {})
    return {
      id, name, owner: owner.name,
      ...messageCountWithDate,
    }
  }

  createHeaders() {
    return [
      "id", "name", "owner",
      ...Dates.createDatesWith7DaysIntervals(
        this.messages.oldest,
        new Date()
      ).map(it => this.formatDate(it))
    ];
  }
}

class Channels {
  /**
   * @param {Channel[]} list
   */
  constructor(list) {
    this.list = list;
  }

  toJson() {
    return this.list.map(it => it.toJson())
  }

  createHeaders() {
    return this.list[0].createHeaders();
  }
}

/**
 * @returns {Promise<User>}
 */
async function createUser(id) {
  const { user } = (await client.users.info({ user: id }));
  return new User(user.id, user.name);
}

/**
 * @param {string} id
 * @param {Date} oldest
 * @returns {Promise<Messages>}
 */
async function createMessages(id, oldest) {
  const { messages } = await client.conversations.history({
    channel: id,
    limit: 1000,
    oldest: oldest.getTime() / 1000,
  });
  return new Messages(
    messages.map(({ text, ts }) => new Message(text, new Date(ts * 1000))),
    oldest
  );
}

/**
 * @returns {Promise<any[]>}
 */
async function createRawChannels() {
  const fetchedChannels = [];
  let cursor = undefined;
  do {
    const result = await client.channels.list({ cursor });
    fetchedChannels.push(...result.channels);
    cursor = result.response_metadata.next_cursor;
  } while (cursor);
  return fetchedChannels;
}

const client = new WebClient(process.env.TOKEN);
async function main() {
  const fetchedChannels = await createRawChannels();

  const channels = new Channels(
    await Promise.all(
      fetchedChannels
      .filter(it => includes(it, CHANNELS))
      .map(async ({ id, name, creator }) =>
        new Channel(id, name,
          await createUser(creator),
          await createMessages(id, new Date(2020, 0, 1)),
        )
      )
    )
  );

  const json = channels.toJson();
  const headers = channels.createHeaders();

  const csv = toCsv(json, headers);
  await writeFileAsync("./result.csv", csv);
  await writeFileAsync("./visualize.json", JSON.stringify(json));
}

main();

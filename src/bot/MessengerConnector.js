/*
  eslint-disable class-methods-use-this
  @flow
*/
import crypto from 'crypto';

import { MessengerClient } from 'messaging-api-messenger';
import warning from 'warning';
import isAfter from 'date-fns/is_after';
import isValid from 'date-fns/is_valid';

import MessengerContext from '../context/MessengerContext';
import MessengerEvent, {
  type MessengerRawEvent,
  type Sender,
  type Recipient,
  type Message,
  type Postback,
  type PolicyEnforcement,
  type AppRoles,
  type PassThreadControl,
  type TakeThreadControl,
} from '../context/MessengerEvent';
import type { Session } from '../session/Session';

import type { Connector } from './Connector';

type Entry = {
  ['messaging' | 'standby']: Array<{
    sender: Sender,
    recipient: Recipient,
    timestamp: number,
    postback?: Postback,
    message?: Message,
  }>,
};

type EntryRequestBody = {
  type: string,
  entry: Array<Entry>,
};

type PolicyEnforcementRequestBody = {
  recipient: Recipient,
  timestamp: number,
  'policy-enforcement': PolicyEnforcement,
};

type AppRolesRequestBody = {
  recipient: Recipient,
  timestamp: number,
  app_roles: AppRoles,
};

type PassThreadControlRequestBody = {
  sender: Sender,
  recipient: Recipient,
  timestamp: number,
  pass_thread_control: PassThreadControl,
};

type TakeThreadControlRequestBody = {
  sender: Sender,
  recipient: Recipient,
  timestamp: number,
  take_thread_control: TakeThreadControl,
};

type MessengerRequestBody =
  | EntryRequestBody
  | PolicyEnforcementRequestBody
  | AppRolesRequestBody
  | PassThreadControlRequestBody
  | TakeThreadControlRequestBody;

type ConstructorOptions = {|
  accessToken?: string,
  appSecret?: string,
  client?: MessengerClient,
|};

export default class MessengerConnector
  implements Connector<MessengerRequestBody> {
  _client: MessengerClient;
  _appSecret: ?string;

  constructor({ accessToken, appSecret, client }: ConstructorOptions) {
    this._client = client || MessengerClient.connect(accessToken);
    this._appSecret = appSecret;
    if (!this._appSecret) {
      warning(
        false,
        '`appSecret` is not set. Will bypass Messenger signature validation.\nPass in `appSecret` to perform Messenger signature validation.'
      );
    }
  }

  _getRawEventsFromRequest(
    body: MessengerRequestBody
  ): Array<MessengerRawEvent> {
    if (body.entry) {
      const { entry } = ((body: any): EntryRequestBody);

      return entry
        .map(ent => {
          if (ent.messaging) {
            return ((ent.messaging[0]: any): MessengerRawEvent);
          }

          if (ent.standby) {
            return ((ent.standby[0]: any): MessengerRawEvent);
          }
          // $FlowExpectedError
          return null;
        })
        .filter(event => event != null);
    }

    return [((body: any): MessengerRawEvent)];
  }

  _isStandby(body: MessengerRequestBody): boolean {
    if (!body.entry) return false;
    const entry = ((body: any): EntryRequestBody).entry[0];

    return !!entry.standby;
  }

  _profilePicExpired(user: { profile_pic: string }): boolean {
    try {
      // Facebook CDN returns expiration time in the key `oe` in url params
      // https://stackoverflow.com/questions/27595679/how-to-efficiently-retrieve-expiration-date-for-facebook-photo-url-and-renew-it/27596727#27596727
      const oe = user.profile_pic.split('oe=')[1];
      const timestamp = +`0x${oe}` * 1000;
      const expireTime = new Date(timestamp);
      return !(isValid(expireTime) && isAfter(expireTime, new Date()));
    } catch (e) {
      return true;
    }
  }

  get platform(): string {
    return 'messenger';
  }

  get client(): MessengerClient {
    return this._client;
  }

  getUniqueSessionKey(body: MessengerRequestBody): ?string {
    const rawEvent = this._getRawEventsFromRequest(body)[0];
    if (rawEvent.message && rawEvent.message.is_echo && rawEvent.recipient) {
      return rawEvent.recipient.id;
    }
    if (rawEvent.sender) {
      return rawEvent.sender.id;
    }
    return null;
  }

  async updateSession(
    session: Session,
    body: MessengerRequestBody
  ): Promise<void> {
    if (!session.user || this._profilePicExpired(session.user)) {
      const senderId = this.getUniqueSessionKey(body);
      // FIXME: refine user
      const user = await this._client.getUserProfile(senderId);
      session.user = {
        _updatedAt: new Date().toISOString(),
        ...user,
        id: senderId,
      };
    }

    // TODO: remove later
    if (!session.user._updatedAt) {
      session.user._updatedAt = new Date().toISOString();
    }

    Object.freeze(session.user);
    Object.defineProperty(session, 'user', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: session.user,
    });
  }

  mapRequestToEvents(body: MessengerRequestBody): Array<MessengerEvent> {
    const rawEvents = this._getRawEventsFromRequest(body);
    const isStandby = this._isStandby(body);
    return rawEvents.map(event => new MessengerEvent(event, { isStandby }));
  }

  createContext({
    event,
    session,
    initialState,
  }: {
    event: MessengerEvent,
    session: ?Session,
    initialState: Object,
  }): MessengerContext {
    return new MessengerContext({
      client: this._client,
      event,
      session,
      initialState,
    });
  }

  // https://developers.facebook.com/docs/messenger-platform/webhook#security
  verifySignature(rawBody: string, signature: string): boolean {
    if (!this._appSecret) {
      return true;
    }
    return (
      signature ===
      `sha1=${crypto
        .createHmac('sha1', this._appSecret)
        .update(rawBody, 'utf8')
        .digest('hex')}`
    );
  }
}

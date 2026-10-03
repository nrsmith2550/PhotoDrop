import { Readable } from 'node:stream';
import { OAuth2Client } from 'google-auth-library';
import { drive as driveClient } from '@googleapis/drive';

export const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

export const oauthClient = () =>
  new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL}/auth/google/callback`
  );

export function authUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token
    scope: SCOPES,
    state,
  });
}

const driveFor = (refreshToken) => {
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: refreshToken });
  return driveClient({ version: 'v3', auth });
};

export async function createFolder(refreshToken, name) {
  const { data } = await driveFor(refreshToken).files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return data.id;
}

export async function uploadFile(refreshToken, folderId, { name, mimeType, buffer }) {
  const { data } = await driveFor(refreshToken).files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id',
  });
  return data.id;
}

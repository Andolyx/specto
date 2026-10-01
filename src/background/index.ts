import { debounce, get } from "es-toolkit/compat";

import { caseString, openUrl } from "~/common/helpers";
import { stores } from "~/common/stores";
import type { HelixStream, HelixUser } from "~/common/types";

import { refreshActionBadge } from "./modules/badge";
import { backup, reset, restore } from "./modules/maintenance";
import { sendStreamNotifications } from "./modules/notification";
import {
  authorize,
  filterMutedStreams,
  filterNewStreams,
  getCurrentUser,
  getFollowedStreams,
  handleUnauthorized,
  isSessionCookie,
  isUnauthorizedError,
  KICK_URL,
  request,
  revoke,
} from "./modules/kick";

async function refresh(withNotifications: boolean) {
  let currentUser: HelixUser | null = null;

  let followedStreams: HelixStream[] = [];
  let filteredStreams: HelixStream[] = [];

  let periodInMinutes = 1;

  try {
    const settings = await stores.settings.get();

    periodInMinutes = settings.general.refreshInterval;

    currentUser = await getCurrentUser();

    if (currentUser) {
      followedStreams = await getFollowedStreams();

      for (const stream of followedStreams) {
        stream.title = caseString(stream.title, settings.streams.titleCase);
      }

      filteredStreams = await filterMutedStreams(followedStreams);

      if (withNotifications) {
        sendStreamNotifications(await filterNewStreams(filteredStreams));
      }
    }
  } catch (error) {
    if (isUnauthorizedError(error)) {
      await handleUnauthorized();

      currentUser = null;
    }
  }

  browser.alarms.create("refresh", {
    periodInMinutes,
  });

  refreshActionBadge(!!currentUser, filteredStreams.length);

  stores.currentUser.set(currentUser);
  stores.followedStreams.set(followedStreams);
}

async function checkAlaram() {
  if (await browser.alarms.get("refresh")) {
    return;
  }

  refresh(false);
}

browser.alarms.onAlarm.addListener((alarm) => {
  refresh(Date.now() < alarm.scheduledTime + 300_000);
});

browser.notifications.onClicked.addListener((notificationId) => {
  const [, type, data] = notificationId.split(":");

  switch (type) {
    case "authorize":
      return authorize();

    case "stream":
      return openUrl(`${KICK_URL}/${data}`);
  }
});

browser.runtime.onInstalled.addListener(() => refresh(false));
browser.runtime.onStartup.addListener(() => refresh(false));

const messageHandlers = { authorize, backup, refresh, request, reset, restore, revoke };

browser.runtime.onMessage.addListener((message) => {
  const handler = get(messageHandlers, message.type);

  if (handler == null) {
    throw new RangeError("Message not found");
  }

  return handler(...message.args);
});

const refreshSession = debounce(() => refresh(false), 2000);

browser.cookies.onChanged.addListener(({ cookie }) => {
  if (isSessionCookie(cookie)) {
    refreshSession();
  }
});

stores.settings.onChange(() => refresh(false));

checkAlaram();

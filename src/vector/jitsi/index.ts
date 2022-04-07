/*
Copyright 2020 New Vector Ltd.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { KJUR } from 'jsrsasign';
import {
    IOpenIDCredentials,
    IWidgetApiRequest,
    VideoConferenceCapabilities,
    WidgetApi,
} from "matrix-widget-api";
import { ElementWidgetActions } from "matrix-react-sdk/src/stores/widgets/ElementWidgetActions";
import { logger } from "matrix-js-sdk/src/logger";
import { IConfigOptions } from "matrix-react-sdk/src/IConfigOptions";
import { SnakedObject } from "matrix-react-sdk/src/utils/SnakedObject";

import { getVectorConfig } from "../getconfig";

// We have to trick webpack into loading our CSS for us.
require("./index.scss");

const JITSI_OPENIDTOKEN_JWT_AUTH = 'openidtoken-jwt';

// Dev note: we use raw JS without many dependencies to reduce bundle size.
// We do not need all of React to render a Jitsi conference.

declare let JitsiMeetExternalAPI: any;

let inConference = false;

// Jitsi params
let jitsiDomain: string;
let conferenceId: string;
let displayName: string;
let avatarUrl: string;
let userId: string;
let jitsiAuth: string;
let roomId: string;
let openIdToken: IOpenIDCredentials;
let roomName: string;
let startAudioOnly: boolean;

let widgetApi: WidgetApi;
let meetApi: any; // JitsiMeetExternalAPI
let skipOurWelcomeScreen = false;

(async function() {
    try {
        // Queue a config.json lookup asap, so we can use it later on. We want this to be concurrent with
        // other setup work and therefore do not block.
        const configPromise = getVectorConfig('..');

        // The widget's options are encoded into the fragment to avoid leaking info to the server.
        const widgetQuery = new URLSearchParams(window.location.hash.substring(1));
        // The widget spec on the other hand requires the widgetId and parentUrl to show up in the regular query string.
        const realQuery = new URLSearchParams(window.location.search.substring(1));
        const qsParam = (name: string, optional = false): string => {
            const vals = widgetQuery.has(name) ? widgetQuery.getAll(name) : realQuery.getAll(name);
            if (!optional && vals.length !== 1) {
                throw new Error(`Expected singular ${name} in query string`);
            }
            return <string>vals[0];
        };

        // If we have these params, expect a widget API to be available (ie. to be in an iframe
        // inside a matrix client). Otherwise, assume we're on our own, eg. have been popped
        // out into a browser.
        const parentUrl = qsParam('parentUrl', true);
        const widgetId = qsParam('widgetId', true);
        const theme = qsParam('theme', true);

        if (theme) {
            document.body.classList.add(`theme-${theme.replace(" ", "_")}`);
        }

        // Set this up as early as possible because Element will be hitting it almost immediately.
        let readyPromise: Promise<[void, void]>;
        if (parentUrl && widgetId) {
            const parentOrigin = new URL(qsParam('parentUrl')).origin;
            widgetApi = new WidgetApi(qsParam("widgetId"), parentOrigin);
            widgetApi.requestCapabilities(VideoConferenceCapabilities);
            readyPromise = Promise.all([
                new Promise<void>(resolve => {
                    widgetApi.once(`action:${ElementWidgetActions.ClientReady}`, ev => {
                        ev.preventDefault();
                        widgetApi.transport.reply(ev.detail, {});
                        resolve();
                    });
                }),
                new Promise<void>(resolve => {
                    widgetApi.once("ready", () => resolve());
                }),
            ]);
            widgetApi.start();
        } else {
            logger.warn("No parent URL or no widget ID - assuming no widget API is available");
        }

        // Populate the Jitsi params now
        jitsiDomain = qsParam('conferenceDomain');
        conferenceId = qsParam('conferenceId');
        displayName = qsParam('displayName', true);
        avatarUrl = qsParam('avatarUrl', true); // http not mxc
        userId = qsParam('userId');
        jitsiAuth = qsParam('auth', true);
        roomId = qsParam('roomId', true);
        roomName = qsParam('roomName', true);
        startAudioOnly = qsParam('isAudioOnly', true) === "true";

        // We've reached the point where we have to wait for the config, so do that then parse it.
        const instanceConfig = new SnakedObject<IConfigOptions>((await configPromise) ?? <IConfigOptions>{});
        const jitsiConfig = instanceConfig.get("jitsi_widget") ?? {};
        skipOurWelcomeScreen = (new SnakedObject<IConfigOptions["jitsi_widget"]>(jitsiConfig))
            .get("skip_built_in_welcome_screen") || false;

        // If we're meant to skip our screen, skip to the part where we show Jitsi instead of us.
        // We don't set up the call yet though as this might lead to failure without the widget API.
        if (skipOurWelcomeScreen) {
            toggleConferenceVisibility(true);
        }

        if (widgetApi) {
            await readyPromise;
            await widgetApi.setAlwaysOnScreen(false); // start off as detachable from the screen

            // See https://github.com/matrix-org/prosody-mod-auth-matrix-user-verification
            if (jitsiAuth === JITSI_OPENIDTOKEN_JWT_AUTH) {
                // Request credentials, give callback to continue when received
                openIdToken = await widgetApi.requestOpenIDConnectToken();
                logger.log("Got OpenID Connect token");
            }

            // TODO: register widgetApi listeners for PTT controls (https://github.com/vector-im/element-web/issues/12795)

            widgetApi.on(`action:${ElementWidgetActions.HangupCall}`,
                (ev: CustomEvent<IWidgetApiRequest>) => {
                    if (meetApi) meetApi.executeCommand('hangup');
                    widgetApi.transport.reply(ev.detail, {}); // ack
                },
            );
            widgetApi.on(`action:${ElementWidgetActions.StartLiveStream}`,
                (ev: CustomEvent<IWidgetApiRequest>) => {
                    if (meetApi) {
                        meetApi.executeCommand('startRecording', {
                            mode: 'stream',
                            // this looks like it should be rtmpStreamKey but we may be on too old
                            // a version of jitsi meet
                            //rtmpStreamKey: ev.detail.data.rtmpStreamKey,
                            youtubeStreamKey: ev.detail.data.rtmpStreamKey,
                        });
                        widgetApi.transport.reply(ev.detail, {}); // ack
                    } else {
                        widgetApi.transport.reply(ev.detail, { error: { message: "Conference not joined" } });
                    }
                },
            );
        }

        // Now that everything should be set up, skip to the Jitsi splash screen if needed
        if (skipOurWelcomeScreen) {
            skipToJitsiSplashScreen();
        }

        enableJoinButton(); // always enable the button
    } catch (e) {
        logger.error("Error setting up Jitsi widget", e);
        document.getElementById("widgetActionContainer").innerText = "Failed to load Jitsi widget";
    }
})();

function enableJoinButton() {
    document.getElementById("joinButton").onclick = () => joinConference();
}

function switchVisibleContainers() {
    inConference = !inConference;

    // Our welcome screen is managed by other code, so just don't switch to it ever
    // if we're not supposed to.
    if (!skipOurWelcomeScreen) {
        toggleConferenceVisibility(inConference);
    }
}

function toggleConferenceVisibility(inConference: boolean) {
    document.getElementById("jitsiContainer").style.visibility = inConference ? 'unset' : 'hidden';
    document.getElementById("joinButtonContainer").style.visibility = inConference ? 'hidden' : 'unset';
}

function skipToJitsiSplashScreen() {
    // really just a function alias for self-documenting code
    joinConference();
}

/**
 * Create a JWT token fot jitsi openidtoken-jwt auth
 *
 * See https://github.com/matrix-org/prosody-mod-auth-matrix-user-verification
 */
function createJWTToken() {
    // Header
    const header = { alg: 'HS256', typ: 'JWT' };
    // Payload
    const payload = {
        // As per Jitsi token auth, `iss` needs to be set to something agreed between
        // JWT generating side and Prosody config. Since we have no configuration for
        // the widgets, we can't set one anywhere. Using the Jitsi domain here probably makes sense.
        iss: jitsiDomain,
        sub: jitsiDomain,
        aud: `https://${jitsiDomain}`,
        room: "*",
        context: {
            matrix: {
                token: openIdToken.access_token,
                room_id: roomId,
                server_name: openIdToken.matrix_server_name,
            },
            user: {
                avatar: avatarUrl,
                name: displayName,
            },
        },
    };
    // Sign JWT
    // The secret string here is irrelevant, we're only using the JWT
    // to transport data to Prosody in the Jitsi stack.
    return KJUR.jws.JWS.sign(
        'HS256',
        JSON.stringify(header),
        JSON.stringify(payload),
        'notused',
    );
}

function joinConference() { // event handler bound in HTML
    let jwt;
    if (jitsiAuth === JITSI_OPENIDTOKEN_JWT_AUTH) {
        if (!openIdToken?.access_token) { // eslint-disable-line camelcase
            // We've failing to get a token, don't try to init conference
            logger.warn('Expected to have an OpenID credential, cannot initialize widget.');
            document.getElementById("widgetActionContainer").innerText = "Failed to load Jitsi widget";
            return;
        }
        jwt = createJWTToken();
    }

    switchVisibleContainers();

    logger.warn(
        "[Jitsi Widget] The next few errors about failing to parse URL parameters are fine if " +
        "they mention 'external_api' or 'jitsi' in the stack. They're just Jitsi Meet trying to parse " +
        "our fragment values and not recognizing the options.",
    );
    const options = {
        width: "100%",
        height: "100%",
        parentNode: document.querySelector("#jitsiContainer"),
        roomName: conferenceId,
        interfaceConfigOverwrite: {
            SHOW_JITSI_WATERMARK: false,
            SHOW_WATERMARK_FOR_GUESTS: false,
            MAIN_TOOLBAR_BUTTONS: [],
            VIDEO_LAYOUT_FIT: "height",
        },
        configOverwrite: {
            startAudioOnly,
        },
        jwt: jwt,
    };

    meetApi = new JitsiMeetExternalAPI(jitsiDomain, options);
    if (displayName) meetApi.executeCommand("displayName", displayName);
    if (avatarUrl) meetApi.executeCommand("avatarUrl", avatarUrl);
    if (userId) meetApi.executeCommand("email", userId);
    if (roomName) meetApi.executeCommand("subject", roomName);

    // fires once when user joins the conference
    // (regardless of video on or off)
    meetApi.on("videoConferenceJoined", () => {
        if (widgetApi) {
            // ignored promise because we don't care if it works
            // noinspection JSIgnoredPromiseFromCall
            widgetApi.setAlwaysOnScreen(true);
        }
    });

    meetApi.on("readyToClose", () => {
        switchVisibleContainers();

        if (widgetApi) {
            // ignored promise because we don't care if it works
            // noinspection JSIgnoredPromiseFromCall
            widgetApi.setAlwaysOnScreen(false);
        }

        document.getElementById("jitsiContainer").innerHTML = "";
        meetApi = null;

        if (skipOurWelcomeScreen) {
            skipToJitsiSplashScreen();
        }
    });
}

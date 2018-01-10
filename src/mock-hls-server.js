const express = require('express');
const path = require('path');
const querystring = require('querystring');
const fetch = require('node-fetch');
const UrlToolkit = require('url-toolkit');
const winston = require('winston');
const PlaylistParser = require('./playlist-parser');

const PROXY_PATH = '/proxy';
const PROXY_QUERY_PARAM = 'url';

class MockHLSServer {
    constructor({ host = 'localhost', port = 8080, windowSize = 10, initialDuration = 20, logLevel = 'info' }) {
        this._logger = new winston.Logger({
            level: logLevel,
            transports: [
                new winston.transports.Console({
                    handleExceptions: true,
                    exitOnError: false
                })
            ]
        });
        this._proxyBaseUrl = 'http://' + host + ':' + port + PROXY_PATH + '?' + PROXY_QUERY_PARAM + '=';
        this._startTime = null;
        this._initialDuration = initialDuration;
        this._windowSize = windowSize;

        const app = this._app = express();
        app.get(PROXY_PATH, (req, res, next) => {
            const url = req.query.url;
            if (!url) {
                throw new Error('\'url\' query param missing.');
            }
            this._logger.debug('Got request.', url);
            fetch(url).then((fetchRes) => Promise.all([Promise.resolve(fetchRes), fetchRes.text()])).then(([ fetchRes, content ]) => {
                res.status(fetchRes.status);
                res.set('Access-Control-Allow-Origin', '*');
                res.set('content-type', fetchRes.headers.get('content-type'));
                if (path.extname(url).indexOf('.m3u8') === 0) {
                    this._logger.debug('Handling playlist request.', url);
                    res.send(this._handlePlaylistResponse(content, url));
                } else {
                    res.send(content);
                }
                this._logger.debug('Sent response.', url);
            }).catch((e) => {
                this._logger.error('Error proxying request.', url, e);
                next(e);
            });
        });

        app.listen(port, host, () => {
            this._logger.info('Started on ' + host + ':' + port + '!')
        });
    }
    
    reset() {
        this._startTime = null;
        this._logger.info('Reset.');
    }
    
    stop() {
        this._app.close();
        this._logger.info('Stopped.');
    }

    _getTime() {
        return this._startTime ? (Date.now() - this._startTime) / 1000 : 0;
    }

    _handlePlaylistResponse(body, playlistUrl) {
        if (!this._startTime) {
            this._startTime = Date.now() - (this._initialDuration * 1000);
            this._logger.debug('Started stream.');
        }
        let parsedPlaylist, parsedVariantPlaylist;
        if (parsedPlaylist = PlaylistParser.parsePlaylist(body)) {
            this._logger.debug('Building playlist response.');
            return this._buildPlaylistResponse(parsedPlaylist);
        } else if (parsedVariantPlaylist = PlaylistParser.parseVariantPlaylist(body)) {
            this._logger.debug('Building variant playlist response.');
            return this._buildVariantPlaylistResponse(parsedVariantPlaylist, playlistUrl);
        } else {
            this._logger.warn('Unable to parse playlist.', playlistUrl);
            return body;
        }
    }

    _buildPlaylistResponse(parsedPlaylist) {
        const currentTime = this._getTime();
        const windowSize = this._windowSize;
        let { header, rest: visibleArea } = this._splitPlaylistIntoHeaderAndRest(parsedPlaylist, currentTime);
        let mediaSequence = -1;
        if (windowSize !== null) {
            // we should remove the content from the start of the playlist that has expired
            const startTime = Math.max(0, currentTime - windowSize);
            let visibleAreaStart = 0;
            visibleArea.some((line, i) => {
                if (line.metadata && line.metadata.type === 'url') {
                    if (line.metadata.time > startTime) {
                        return true;
                    }
                    mediaSequence++;
                    visibleAreaStart = line.metadata.startIndex - header.length;
                };
                return false;
            });
            visibleArea = visibleArea.slice(visibleAreaStart);
        }
        // remove the playlist type if it is set because we are pretending it is live
        // remove the media seauence tag if it is there because we will rewrite it later
        header = header.filter((line) => {
            return !/(^#EXT-X-PLAYLIST-TYPE:)|(^#EXT-X-MEDIA-SEQUENCE:)/.test(line.raw);
        });
        // remove the endlist tag if it is there because we will add it later if necessary
        visibleArea = visibleArea.filter((line) => line.raw !== '#EXT-X-ENDLIST');
        if (windowSize !== null) {
            header.splice(1, 0, { raw: '#EXT-X-MEDIA-SEQUENCE:' + mediaSequence });
        } else {
            header.splice(1, 0, { raw: '#EXT-X-PLAYLIST-TYPE:EVENT' });
            if (reachedEnd) {
                visibleArea.push({ raw: '#EXT-X-ENDLIST' });
            }
        }
        return [ ...header, ...visibleArea ].map((line) => line.raw).join('\r\n') + '\r\n';
    }

    _buildVariantPlaylistResponse(parsedPlaylist, playlistUrl) {
        return parsedPlaylist.map((line) => {
            if (line.metadata && line.metadata.type === 'url') {
                return this._rewriteUrl(playlistUrl, line.raw);
            }
            return line.raw;
        }).join('\r\n') + '\r\n';
    }

    _splitPlaylistIntoHeaderAndRest(parsedPlaylist, currentTime) {
        let headerEnd = 0;
        let visibleAreaEnd = 0;
        const reachedEnd = !parsedPlaylist.some((line, i) => {
            if (line.metadata && line.metadata.type === 'url') {
                if (!headerEnd) {
                    headerEnd = line.metadata.startIndex;
                }
                if (line.metadata.time > currentTime) {
                    return true;
                }
                visibleAreaEnd = i + 1;
            }
            return false;
        });
        return {
            header: parsedPlaylist.slice(0, headerEnd),
            rest: parsedPlaylist.slice(headerEnd, reachedEnd ? parsedPlaylist.length : visibleAreaEnd)
        };
    }

    _rewriteUrl(baseUrl, url) {
        return (
            '# Original URL: ' +
            url +
            '\r\n' +
            this._proxyBaseUrl +
            querystring.escape(
                UrlToolkit.buildAbsoluteURL(baseUrl, url, { alwaysNormalize: true })
            )
        );
    }
}

module.exports = MockHLSServer;
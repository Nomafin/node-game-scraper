// Usage: node scrape-game.js season startGameId [endGameId]
// season: the year in which a season started. The 2016-2017 season would be specified as 2016
// startGameId & endGameId: 5 digits long (e.g., 20243)
// If endGameId is specified, all games between startGameId and endGameId (inclusive) are scraped

// TODO
// - Only scrape game if it's final
// - If a local file is already found, delete the game from the database before inserting new records
// - Handle exceptions like the Winter Classic and inaccurate penalty information

var fs = require("fs");
var request = require("request");

// Parse and store season argument
var season = parseInt(process.argv[2]);

// Parse and store gameId argument
var startAndEndGameIds = process.argv[3];
var startGameId;
var endGameId;
if (startAndEndGameIds.indexOf("-") >= 0) {
	startGameId = parseInt(startAndEndGameIds.substring(0, startAndEndGameIds.indexOf("-")));
	endGameId = parseInt(startAndEndGameIds.substring(startAndEndGameIds.indexOf("-") + 1));
} else {
	startGameId = parseInt(startAndEndGameIds);
}

// Parse and store argument to always download input files
var isAlwaysDownloadInputFiles = false;
if (process.argv[4]) {
	if (process.argv[4].toLowerCase() === "download") {
		isAlwaysDownloadInputFiles = true;
	}
}

// Validate arguments
if (!season || season < 2016) {
	console.log("Season must be 2016 or later.");
	return;
} else if (!startGameId || startGameId <= 20000 || startGameId >= 40000) {
	console.log("Invalid starting game ID.");
	return;
	if (endGameId) {
		if (endGameId <= 20000 || endGameId >= 40000 || endGameId <= startGameId) {
			console.log("Invalid ending game ID.");
			return;
		}
	}
}

// Create array of game ids
// Use the full id including the season — 2016 season + game 20243 becomes 2016020243
var gameIds = [startGameId];
if (endGameId) {
	gameIds = [];
	for (var i = startGameId; i <= endGameId; i++) {
		gameIds.push(i);
	}
}
console.log("Games to scrape: " + gameIds);

//
// Loop through each gameId
//

gameIds.forEach(function(gId) {

	var urlId = season * 1000000 + gId;
	var pbpJson;
	var shiftJson;

	// Download pbp and shift jsons
	var pbpJsonUrl = "https://statsapi.web.nhl.com/api/v1/game/" + urlId  + "/feed/live";
	var shiftJsonUrl = "http://www.nhl.com/stats/rest/shiftcharts?cayenneExp=gameId=" + urlId;

	var pbpLocalPath = "data/" + season + "/input/" + urlId + "-pbp.json";
	var shiftLocalPath = "data/" + season + "/input/" + urlId + "-shifts.json";

	// Try to load local pbp and shift input files - if they don't exist, download them
	var isUseLocalFiles = true;
	try {
		fs.statSync(pbpLocalPath);
		fs.statSync(shiftLocalPath);
	} catch (e) {
		isUseLocalFiles = false;
	}

	// Respect user argument to always download input files
	if (isAlwaysDownloadInputFiles) {
		isUseLocalFiles = false;
	}

	if (isUseLocalFiles) {
		console.log("Game " + gId + ": Using local pbp and shift json files");
		pbpJson = JSON.parse(fs.readFileSync(pbpLocalPath));
		shiftJson = JSON.parse(fs.readFileSync(shiftLocalPath));
		processData(gId, pbpJson, shiftJson);
	} else {

		console.log("Game " + gId + ": Downloading pbp and shift json files");

		// Download pbp json
		request(pbpJsonUrl, function (error, response, body) {
			if (!error && response.statusCode == 200) {
				pbpJson = JSON.parse(body);
				saveFile(pbpLocalPath, body);
				processData(gId, pbpJson, shiftJson);
			} else {
				console.log("Game " + gId + ": Unable to get pbp json: " + error);
			}
		});

		// Download shift json
		request(shiftJsonUrl, function (error, response, body) {
			if (!error && response.statusCode == 200) {
				shiftJson = JSON.parse(body);
				saveFile(shiftLocalPath, body);
				processData(gId, pbpJson, shiftJson);
			} else {
				console.log("Game " + gId + ": Unable to get shift json: " + error);
			}
		});
	}
});

//
// Process pbp and shift data for a specified game
//

function processData(gId, pbpJson, shiftJson) {

	// Only start processing when both pbp and shift jsons are loaded
	if (!pbpJson || !shiftJson) {
		console.log("Game " + gId + ": Waiting for both pbp and shift jsons to be loaded");
		return;
	}
	console.log("Game " + gId + ": Processing pbp and shift jsons");

	// Variables for output
	var gameDate = 0;		// An int including date and time
	var maxPeriod = 0;
	var eventData = [];		// An array of event objects
	var shiftData = [];
	var playerData = {};	// An associative array, using "ID" + playerId as keys. Contains player objects
	var teamData = {		// An associative array, using "away"/"home" as keys. Contains team objects
		away: {},
		home: {}
	};

	// Contexts and stats to record
	var recordedScoreSits = ["-3", "-2", "-1", "0", "1", "2", "3"];
	var recordedStrengthSits = ["ev5", "pp", "sh", "penShot", "other"];
	var recordedStats = ["toi", "ig", "is", "ibs", "ims", "ia1", "ia2", "blocked", "gf", "ga", "sf", "sa", "bsf", "bsa", "msf", "msa", "foWon", "foLost", "ofo", "dfo", "nfo", "penTaken", "penDrawn"];

	// Get game date: convert 2016-11-17T00:30:00Z to 20161117003000
	gameDate = pbpJson.gameData.datetime.dateTime;
	gameDate = gameDate.replace(/-/g, "").replace("T", "").replace(/:/g, "").replace("Z", "");

	//
	// Prepare team output
	//

	var teamsObject = pbpJson.gameData.teams;
	["away", "home"].forEach(function(v) {

		teamData[v]["tricode"] = teamsObject[v]["triCode"].toLowerCase();

		// Initialize contexts and stats
		recordedStrengthSits.forEach(function(str) {
			teamData[v][str] = {};
			recordedScoreSits.forEach(function(sc) {
				teamData[v][str][sc] = {};
				recordedStats.forEach(function(stat) {
					teamData[v][str][sc][stat] = 0;
				});
			});
		});
	});

	//
	// Prepare player output
	// Loop through the properties in pbpJson.gameData.players
	// Each property is a playerId: "prop" is formatted as "ID" + playerId
	//

	var gameDataPlayersObject = pbpJson.gameData.players;
	var boxScoreTeamsObject = pbpJson.liveData.boxscore.teams;
	for (var prop in gameDataPlayersObject) {

		// Check if the property is an actual property of the players object, and doesn't come from the prototype
		if (!gameDataPlayersObject.hasOwnProperty(prop)) {
			continue;
		}

		var pId = gameDataPlayersObject[prop]["id"].toString();
		playerData[pId] = {};
		playerData[pId]["firstName"] = gameDataPlayersObject[prop]["firstName"];
		playerData[pId]["lastName"] = gameDataPlayersObject[prop]["lastName"];
		playerData[pId]["shifts"] = [];

		// Record the player's team, venue, position, and jersey number
		["away", "home"].forEach(function(v) {
			if (boxScoreTeamsObject[v]["players"].hasOwnProperty(prop)) {
				playerData[pId]["position"] = boxScoreTeamsObject[v]["players"][prop]["position"]["code"].toLowerCase();
				playerData[pId]["jersey"] = +boxScoreTeamsObject[v]["players"][prop]["jerseyNumber"];
				playerData[pId]["venue"] = v;
				playerData[pId]["team"] = teamData[v]["tricode"];
			}
		});

		// Initialize contexts and stats
		recordedStrengthSits.forEach(function(str) {
			playerData[pId][str] = {};
			recordedScoreSits.forEach(function(sc) {
				playerData[pId][str][sc] = {};
				recordedStats.forEach(function(stat) {
					playerData[pId][str][sc][stat] = 0;
				});
			});
		});
	}

	//
	// Prepare events output
	// eventsObject is an array of event objects
	//
	
	var isPlayoffs = gId >= 30000;
	var recordedEvents = ["goal", "shot", "missed_shot", "blocked_shot", "faceoff", "penalty"];

	var eventsObject = pbpJson.liveData.plays.allPlays;
	eventsObject.forEach(function(ev) {

		// Skip irrelevant events and skip shootout events
		var type = ev["result"]["eventTypeId"].toLowerCase();
		var period = ev["about"]["period"];
		if (recordedEvents.indexOf(type) < 0) {
			return;
		} else if (!isPlayoffs && period > 4) {
			return;
		}

		// Create object to store event information
		newEv = {};
		newEv["id"] = ev["about"]["eventIdx"];
		newEv["period"] = period;
		newEv["time"] = toSecs(ev["about"]["periodTime"]);
		newEv["description"] = ev["result"]["description"];
		newEv["type"] = type;
		if (ev["result"].hasOwnProperty("secondaryType")) {
			newEv["subtype"] = ev["result"]["secondaryType"].toLowerCase();
		}

		// Record penalty-specific information
		if (type === "penalty") {
			newEv["penSeverity"] = ev["result"]["penaltySeverity"].toLowerCase();
			newEv["penMins"] = ev["result"]["penaltyMinutes"];
		}

		// Record location information
		if (ev.hasOwnProperty("coordinates")) {
			if (ev["coordinates"].hasOwnProperty("x") && ev["coordinates"].hasOwnProperty("y")) {

				newEv["locX"] = ev["coordinates"]["x"];
				newEv["locY"] = ev["coordinates"]["y"];

				// Convert coordinates into a zone (from the home team's perspective)
				// Determine whether the home team's defensive zone has x < 0 or x > 0
				// Starting in 2014-2015, teams switch ends prior to the start of OT in the regular season

				// For even-numbered periods (2, 4, etc.), the home team's defensive zone has x > 0
				var hDefZoneIsNegX = period % 2 == 0 ? false : true;

				// Redlines are located at x = -25 and +25
				if (newEv["locX"] >= -25 && newEv["locX"] <= 25) {
					newEv["hZone"] = "n";
				} else if (hDefZoneIsNegX) {
					if (newEv["locX"] < -25) {
						newEv["hZone"] = "d";
					} else if (newEv["locX"] > 25) {
						newEv["hZone"] = "o";
					}
				} else if (!hDefZoneIsNegX) {
					if (newEv["locX"] < -25) {
						newEv["hZone"] = "o";
					} else if (newEv["locX"] > 25) {
						newEv["hZone"] = "d";
					}
				}
			}
		}

		// Record players and their roles
		// For goals, the json simply lists "assist" for both assisters - enhance this to "assist1" and "assist2"
		if (ev.hasOwnProperty("players")) {
			newEv["roles"] = [];
			ev["players"].forEach(function(p) {
				var pId = p["player"]["id"];
				var role = p["playerType"].toLowerCase();
				if (type === "goal") {
					// Assume the scorer is always listed first, the primary assister listed second, and secondary assister listed third
					if (role === "assist" && pId === ev["players"][1]["player"]["id"]) {
						role = "assist1";
					} else if (role === "assist" && pId === ev["players"][2]["player"]["id"]) {
						role = "assist2";
					}
				}
				newEv["roles"].push({
					player: pId,
					role: role
				});
			});
		}

		// Record team and venue information
		if (ev.hasOwnProperty("team")) {
			newEv["team"] = ev["team"]["triCode"].toLowerCase();
			newEv["venue"] = newEv["team"] === teamData["away"]["tricode"] ? "away" : "home";

			// For blocked shots, the json lists the blocking team as the team - we want the shooting team instead
			if (type === "blocked_shot") {
				newEv["team"] = newEv["team"] === teamData["away"]["tricode"] ? teamData["home"]["tricode"] : teamData["away"]["tricode"];
				newEv["venue"] = newEv["team"] === teamData["away"]["tricode"] ? "home" : "away";
			}
		}

		// Record the home and away scores when the event occurred
		// For goals, the json includes the goal itself in the score situation, but it's more accurate to say that the first goal was scored when it was 0-0
		newEv["score"] = [ev["about"]["goals"]["away"], ev["about"]["goals"]["home"]];
		if (type === "goal") {
			if (newEv["venue"] === "away") {
				newEv["score"][0]--;
			} else if (newEv["venue"] === "home") {
				newEv["score"][1]--;
			}
		}

		// Store event
		eventData.push(newEv);

	}); // Done looping through eventsObject

	// Flag penalty shots by appending {penalty_shot} to the description
	// To find penalty shots, find penalties with severity "penalty shot", then get the next event
	// Since eventData only contains faceoffs, penalties, and shots, we can treat the first shot after the penalty as the penalty shot
	eventData.forEach(function(ev, i) {
		if (ev["type"] === "penalty") {
			if (ev["penSeverity"] === "penalty shot") {
				var j = 1;
				var isPenShotFound = false;
				while (i + j < eventData.length && !isPenShotFound) {
					if (["goal", "shot", "missed_shot", "blocked_shot"].indexOf(eventData[i + j]["type"]) >= 0) {
						eventData[i + 1]["description"] += " {penalty_shot}" 
						isPenShotFound = true;
					} else {
						j++;
					}
				}
			}
		}
	});

	//
	//
	// Process shift data
	//
	//

	shiftJson = shiftJson["data"];

	// Append shifts to the player objects in playerData
	// shiftJson is an array of shift objects
	// Also find the max period
	shiftJson.forEach(function(sh) {
		if ((sh["period"] <= 4 && !isPlayoffs) || isPlayoffs) {
			playerData[sh["playerId"].toString()]["shifts"].push({
				period: sh["period"],
				start: toSecs(sh["startTime"]),
				end: toSecs(sh["endTime"])
			});
			if (sh["period"] > maxPeriod) {
				maxPeriod = sh["period"];
			}
		}
	});

	// Process shifts, one period at a time
	for (var prd = 1; prd <= maxPeriod; prd++) {

		// Set the period duration
		var prdDur = 20 * 60;
		if (!isPlayoffs && prd === 4) {
			prdDur = 5 * 60;
		}

		// Initialize array to store information about each 1-second interval
		// A 4-second period will have 4 intervals: 0:00-0:01, 0:01-0:02, 0:02-0:03, 0:03-0:04
		// E.g., the interval at idx0 counts the number of on-ice players during 0:00-0:01
		var intervals = [];
		for (var t = 0; t < prdDur; t++) {
			// Use idx0 for away; idx1 for away
			var interval = {
				start: t,
				end: t + 1,
				goalies: [[], []],
				skaters: [[], []],
				strengthSits: ["", ""],
				score: [0, 0],
				scoreSits: ["", ""]
			};
			intervals.push(interval);
		}

		// Record on-ice players during each interval
		// If a shift has start=0 and end=2, then add the player to 0:00-0:01, 0:01-0:02, but not 0:02-0:03
		for (var key in playerData) {

			// Check if the property is an actual property of the players object, and doesn't come from the prototype
			if (!playerData.hasOwnProperty(key)) {
				continue;
			}

			// Get player's venue, position, and shifts in the period
			var venueIdx = playerData[key]["venue"] === "away" ? 0 : 1;
			var positionToUpdate = playerData[key]["position"] === "g" ? "goalies" : "skaters";
			var shiftsInPrd = playerData[key]["shifts"].filter(function(d) { return d["period"] === prd; });

			// Loop through each of the player's shifts and add them to the corresponding intervals
			shiftsInPrd.forEach(function(sh) {
				var intervalsToUpdate = intervals.filter(function(d) { return d["start"] >= sh["start"] && d["end"] <= sh["end"]; });
				intervalsToUpdate.forEach(function(interval) {
					interval[positionToUpdate][venueIdx].push(key);
				});
			});
		}

		// Record strength situation during each interval
		intervals.forEach(function(interval) {
			interval["strengthSits"] = getStrengthSits({
				goalieCounts: [interval["goalies"][0].length, interval["goalies"][1].length],
				skaterCounts: [interval["skaters"][0].length, interval["skaters"][1].length]
			});
		});

		// For each interval, record the score
		// For goals scored in previous period, add the goal to every interval of the current period
		// For goals in the current period:
		// 		If goal time = 0: increment 0:00-0:01 and onwards
		// 		If goal time = 1: don't increment 0:00-0:01, but increment 0:01-0:02 and onwards
		// 		If goal time = 2: don't increment 0:01-0:02, but increment 0:02-0:03 and onwards
		// 		If goal time = 3: don't increment 0:02-0:03, but increment 0:03-0:04 and onwards
		// 		If goal time = 4 and the period is 4s long: don't increment 0:03-0:04, and there are no subsequent intervals to increment
		var goals = eventData.filter(function(d) { return d["type"] === "goal" && d["period"] <= prd; });
		goals.forEach(function(g) {

			var venueIdx = g["venue"] === "away" ? 0 : 1;
			
			if (g["period"] < prd) {
				intervals.forEach(function(interval) {
					interval["score"][venueIdx]++;
				});
			} else {
				var intervalsToIncrement = intervals.filter(function(interval) { return interval["start"] >= g["time"]; });
				intervalsToIncrement.forEach(function(interval) {
					interval["score"][venueIdx]++;
				});
			}
		});

		// Record each team's score situation for each interval
		intervals.forEach(function(interval) {
			interval["scoreSits"] = getScoreSits(interval["score"][0], interval["score"][1]);
		});

		//
		// Increment toi for each score and strength situation for players and teams
		//

		intervals.forEach(function(interval) {

			// Loop through away and home teams
			["away", "home"].forEach(function(venue, venueIdx) {

				// Increment players' toi
				interval["skaters"][venueIdx].forEach(function(pId) {
					playerData[pId][interval["strengthSits"][venueIdx]][interval["scoreSits"][venueIdx]]["toi"]++;
				});
				interval["goalies"][venueIdx].forEach(function(pId) {
					playerData[pId][interval["strengthSits"][venueIdx]][interval["scoreSits"][venueIdx]]["toi"]++;
				});

				// Increment teams' toi
				teamData[venue][interval["strengthSits"][venueIdx]][interval["scoreSits"][venueIdx]]["toi"]++;
			});
		});

		//
		// Append on-ice players for each event
		//

		var evsInPrd = eventData.filter(function(d) { return d["period"] === prd; });
		evsInPrd.forEach(function(ev) {

			// If a faceoff occurred at 0:05, then attribute it to all players on ice during interval 0:05-0:06
			// If a shot or penalty occurred at 0:05, then attribute it to all players on ice during interval 0:04-0:05
			var interval;
			if (ev["type"] === "faceoff") {
				interval = intervals.find(function(d) { return d["start"] === ev["time"]; });
			} else {
				interval = intervals.find(function(d) { return d["end"] === ev["time"]; });
			}

			// Record on-ice skaters and goalies
			ev["skaters"] = [[], []];
			ev["goalies"] = [[], []];
			["away", "home"].forEach(function(venue, venueIdx) {
				interval["skaters"][venueIdx].forEach(function(pId) {
					ev["skaters"][venueIdx].push(pId);
				});
				interval["goalies"][venueIdx].forEach(function(pId) {
					ev["goalies"][venueIdx].push(pId);
				});
			});
		});

	} // Done looping through a game's periods

	//
	// For each event, increment player and team stats
	//

	eventData.forEach(function(ev) {
		
		// Get score and strength situations
		var scoreSits = getScoreSits(ev["score"][0], ev["score"][1]);
		var strengthSits = getStrengthSits({
			goalieCounts: [ev["goalies"][0].length, ev["goalies"][1].length],
			skaterCounts: [ev["skaters"][0].length, ev["skaters"][1].length]
		});

		// Update strengthSits for penalty shots
		if (ev["description"].indexOf("{penalty_shot}") > 0) {
			strengthSits = ["penShot", "penShot"];
		}

		// Increment individual stats
		ev["roles"].forEach(function(r) {
			var iStat = [];
			if (r["role"] === "winner") {
				iStat = ["foWon"];
			} else if (r["role"] === "loser") {
				iStat = ["foLost"];
			} else if (r["role"] === "blocker") {
				iStat = ["blocked"];
			} else if (r["role"] === "scorer") {
				iStat = ["ig", "is"];
			} else if (r["role"] === "assist1") {
				iStat = ["ia1"];
			} else if (r["role"] === "assist2") {
				iStat = ["ia2"];
			} else if (r["role"] === "penaltyon") {
				iStat = ["penTaken"];
			} else if (r["role"] === "drewby") {
				iStat = ["penDrawn"];
			} else if (r["role"] === "shooter") {
				if (ev["type"] === "shot") {
					iStat = ["is"];
				} else if (ev["type"] === "blocked_shot") {
					iStat = ["ibs"];
				} else if (ev["type"] === "missed_shot") {
					iStat = ["ims"];
				}
			}
			var playerVenueIdx = 0;
			if (r["player"]["venue"] === "home") {
				playerVenueIdx = 1;
			}
			iStat.forEach(function(is) {
				playerData[r["player"].toString()][strengthSits[playerVenueIdx]][scoreSits[playerVenueIdx]][is]++;
			});
		});

		// Increment team and on-ice stats
		["away", "home"].forEach(function(v, vIdx) {

			var suffix = ev["venue"] === v ? "f" : "a";
			var penSuffix = ev["venue"] === v ? "Taken" : "Drawn";
			var foSuffix = ev["venue"] === v ? "Won" : "Lost";

			if (ev["type"] === "goal") {
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["g" + suffix]++;
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["s" + suffix]++;
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], "g" + suffix, 1);
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], "s" + suffix, 1);
			} else if (ev["type"] === "shot") {
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["s" + suffix]++;
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], "s" + suffix, 1);
			} else if (ev["type"] === "blocked_shot") {
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["bs" + suffix]++;
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], "bs" + suffix, 1);
			} else if (ev["type"] === "missed_shot") {
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["ms" + suffix]++;
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], "ms" + suffix, 1);
			} else if (ev["type"] === "faceoff") {
				// Increment zone faceoffs
				var zone = ev["hZone"];
				if (v === "away") {
					if (zone === "d") {
						zone = "o";
					} else if (zone === "o") {
						zone = "d";
					}
				}
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]][zone + "fo"]++;
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["fo" + foSuffix]++;
				incrementOnIceStats(playerData, ev["skaters"][vIdx], ev["goalies"][vIdx], strengthSits[vIdx], scoreSits[vIdx], zone + "fo", 1);
			} else if (ev["type"] === "penalty") {
				teamData[v][strengthSits[vIdx]][scoreSits[vIdx]]["pen" + penSuffix]++;
			}
		});
	});

	//
	//
	// Write data to output files
	//
	//

	// Write csv header
	var result = "season,date,gameId,team,playerId,strengthSit,scoreSit";
	recordedStats.forEach(function(st) {
		result += "," + st;
	});
	result += "\n";

	// Write team stats
	for (key in teamData) {
		recordedStrengthSits.forEach(function(strSit) {
			recordedScoreSits.forEach(function(scSit) {

				// If all stats=0 for the given strSit and scSit, don't output this line
				var isEmpty = true;
				recordedStats.forEach(function(st) {
					if (teamData[key][strSit][scSit][st] !== 0) {
						isEmpty = false;
					}
				});

				if (!isEmpty) {

					// Create csv line
					var line = season + ","
						+ gameDate + ","
						+ gId + ","
						+ teamData[key]["tricode"] + ","
						+ "0" + ","
						+ strSit + ","
						+ scSit;
					recordedStats.forEach(function(st) {
						line += "," + teamData[key][strSit][scSit][st]
					});
					line += "\n";

					// Add line to result
					result += line;
				}
			});
		});
	}

	// Write player stats
	for (key in playerData) {
		recordedStrengthSits.forEach(function(strSit) {
			recordedScoreSits.forEach(function(scSit) {

				// If all stats=0 for the given strSit and scSit, don't output this line
				var isEmpty = true;
				recordedStats.forEach(function(st) {
					if (playerData[key][strSit][scSit][st] !== 0) {
						isEmpty = false;
					}
				});

				if (!isEmpty) {
					var line = season + ","
						+ gameDate + ","
						+ gId + ","
						+ playerData[key]["team"] + ","
						+ key + ","
						+ strSit + ","
						+ scSit;
					recordedStats.forEach(function(st) {
						line += "," + playerData[key][strSit][scSit][st]
					});
					line += "\n";

					// Add line to result
					result += line;
				}
			});
		});
	}

	saveFile("data/" + season + "/output/" + (season * 1000000 + gId) + "-game_stats.csv", result);

	//
	//
	// TODO: Load files into database
	//
	//
}

// Convert mm:ss to seconds
function toSecs(timeString) {
	var mm = +timeString.substring(0, timeString.indexOf(":"));
	var ss = +timeString.substring(timeString.indexOf(":") + 1);
	return 60 * mm + ss;
}

// Save file to disk
function saveFile(path, contents) {
	fs.writeFile(path, contents, function(err) {
		if (err) {
			 return console.log(err);
		}
	}); 
	return;
}

// Converts away and home scores into [awayScoreSit, homeScoreSit]
function getScoreSits(aScore, hScore) {
	var scoreSits = [];
	scoreSits.push(Math.max(-3, Math.min(3, aScore - hScore))).toString();
	scoreSits.push(Math.max(-3, Math.min(3, hScore - aScore))).toString();
	return scoreSits;
}

// Converts away and home goalie/skater counts into [awayStrengthSit, homeStrengthSit]
// countObject: { goalieCounts: [1, 1], skaterCounts: [5, 5] }
function getStrengthSits(countObject) {
	if (countObject["goalieCounts"][0] < 1 || countObject["goalieCounts"][1] < 1) {
		return ["other", "other"];
	} else if (countObject["skaterCounts"][0] === 5 && countObject["skaterCounts"][1] === 5) {
		return ["ev5", "ev5"];
	} else if (countObject["skaterCounts"][0] > countObject["skaterCounts"][1]
		&& countObject["skaterCounts"][0] <= 6
		&& countObject["skaterCounts"][1] >= 3) {
		return ["pp", "sh"];
	} else if (countObject["skaterCounts"][1] > countObject["skaterCounts"][0]
		&& countObject["skaterCounts"][1] <= 6
		&& countObject["skaterCounts"][0] >= 3) {
		return ["sh", "pp"];
	} else {
		return ["other", "other"];
	}
}

// Given a list of skater and goalie playerIds, increment the specified stat by the specified amount
function incrementOnIceStats(playerData, skaters, goalies, strengthSit, scoreSit, stat, amount) {
	var playersToUpdate = skaters.concat(goalies);
	playersToUpdate.forEach(function(pId) {
		playerData[pId.toString()][strengthSit][scoreSit][stat] += amount;
	});
}
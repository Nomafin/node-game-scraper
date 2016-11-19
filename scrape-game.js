// Usage: node scrape-game.js season startGameId [endGameId]
// season: the year in which a season started. The 2016-2017 season would be specified as 2016
// startGameId & endGameId: 5 digits long (e.g., 20243)
// If endGameId is specified, all games between startGameId and endGameId (inclusive) are scraped

// TO DO
// - Handle exceptions like the Winter Classic and inaccurate penalty information

// Parse and store arguments
var season = parseInt(process.argv[2]);
var startGameId = parseInt(process.argv[3]);
var endGameId = parseInt(process.argv[4]);

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


var request = require("request");

gameIds.forEach(function(gId) {

	var urlId = season * 1000000 + gId;
	var pbpJson;
	var shiftJson;

	// Load pbp and shift jsons
	var pbpJsonUrl = "https://statsapi.web.nhl.com/api/v1/game/" + urlId  + "/feed/live";
	var shiftJsonUrl = "http://www.nhl.com/stats/rest/shiftcharts?cayenneExp=gameId=" + urlId;
	request(pbpJsonUrl, function (pbpError, pbpResponse, pbpBody) {
		if (!pbpError && pbpResponse.statusCode == 200) {
			pbpJson = JSON.parse(pbpBody);

			// Load shift json
			request(shiftJsonUrl, function (shiftError, shiftResponse, shiftBody) {
				if (!shiftError && shiftResponse.statusCode == 200) {
					shiftJson = JSON.parse(shiftBody);
					shiftJson = shiftJson.data;
					processData(gId, pbpJson, shiftJson);
				} else {
					console.log(shiftError);
				}
			});
		} else {
			console.log(pbpError);
		}
	});
});

function processData(gId, pbpJson, shiftJson) {

	// Variables for output
	var gameDate = 0;		// An int including date and time
	var maxPeriod = 0;
	var eventData = [];		// An array of event objects
	var shiftData = [];
	var playerData = {};	// An associative array, using "ID" + playerId as keys. Contains player objects
	var teamData = {		// An associate array, using "away"/"home" as keys. Contains team objects
		away: {},
		home: {}
	};

	// Contexts and stats to record
	var recordedScoreDiffs = ["-3", "-2", "-1", "0", "1", "2", "3"];
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
			recordedScoreDiffs.forEach(function(sc) {
				teamData[v][str][sc] = {};
				recordedStats.forEach(function(stat) {
					teamData[v][str][sc][stat] = 0;
				});
			});
		});
	});

	//
	// Prepare player output
	// Loop through the properties in pbpJson.gameData.players — each property is a playerId
	// "prop" is formatted as "ID" + playerId
	//

	var gameDataPlayersObject = pbpJson.gameData.players;
	var boxScoreTeamsObject = pbpJson.liveData.boxscore.teams;
	for (var prop in gameDataPlayersObject) {

		// Check if the property is an actual property of the players object, and doesn't come from the prototype
		if (!gameDataPlayersObject.hasOwnProperty(prop)) {
			continue;
		}

		playerData[prop] = {};
		playerData[prop]["id"] = gameDataPlayersObject[prop]["id"];
		playerData[prop]["firstName"] = gameDataPlayersObject[prop]["firstName"];
		playerData[prop]["lastName"] = gameDataPlayersObject[prop]["lastName"];
		playerData[prop]["shifts"] = [];

		// Record the player's team, venue, position, and jersey number
		["away", "home"].forEach(function(v) {
			if (boxScoreTeamsObject[v]["players"].hasOwnProperty(prop)) {
				playerData[prop]["position"] = boxScoreTeamsObject[v]["players"][prop]["position"]["code"].toLowerCase();
				playerData[prop]["jersey"] = +boxScoreTeamsObject[v]["players"][prop]["jerseyNumber"];
				playerData[prop]["venue"] = v;
				playerData[prop]["team"] = teamData[v]["tricode"];
			}
		});

		// Initialize contexts and stats
		recordedStrengthSits.forEach(function(str) {
			playerData[prop][str] = {};
			recordedScoreDiffs.forEach(function(sc) {
				playerData[prop][str][sc] = {};
				recordedStats.forEach(function(stat) {
					playerData[prop][str][sc][stat] = 0;
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
			var evRoles = [];
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
				evRoles.push({
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
		newEv["aScore"] = ev["about"]["goals"]["away"];
		newEv["hScore"] = ev["about"]["goals"]["home"];
		if (type === "goal") {
			if (newEv["venue"] === "away") {
				newEv["aScore"]--;
			} else if (newEv["venue"] === "home") {
				newEv["hScore"]--;
			}
		}

		// Store event
		eventData.push(newEv);

	}); // Done looping through eventsObject

	//
	// Flag penalty shots by appending {penalty_shot} to the description
	// To find penalty shots, find penalties with severity "penalty shot", then get the next event
	// Since eventData only contains faceoffs, penalties, and shots, we can treat the first shot after the penalty as the penalty shot
	//

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

	// Append shifts to the player objects in playerData
	// shiftJson is an array of shift objects
	// Also find the max period
	shiftJson.forEach(function(sh) {
		if ((sh["period"] <= 4 && !isPlayoffs) || isPlayoffs) {
			playerData["ID" + sh["playerId"]]["shifts"].push({
				period: sh["period"],
				start: toSecs(sh["startTime"]),
				end: toSecs(sh["endTime"])
			});
			if (sh["period"] > maxPeriod) {
				maxPeriod = sh["period"];
			}
		}
	});

	//
	// Process shifts one period at a time
	//

	for (var prd = 1; prd <= maxPeriod; prd++) {

		// Record the number of home and away skaters on-ice at each second of the period
		var prdDur = 20 * 60;
		if (!isPlayoffs && prd === 4) {
			prdDur = 5 * 60;
		}

		// Initialize array to store information about each second
		// A 4s period will have 4 elements: 0:00-0:01, 0:01-0:02, 0:02-0:03, 0:03-0:04
		// Each element represents a 1s slot: e.g., idx 0 counts the number of players on-ice between 0:00-0:01
		var seconds = [];
		for (var t = 0; t < prdDur; t++) {
			// Use idx0 for away; idx1 for away
			var second = {
				goalies: [[], []],
				skaters: [[], []],
				strengthSits: ["", ""],
				score: [0, 0]
			};
			seconds.push(second);
		}

		// Record players on ice at each second
		// If a shift starts and ends at [0, 2], then add the player to 0:00-0:01 (idx0), 0:01-0:02 (idx1)
		for (var key in playerData) {

			// Check if the property is an actual property of the players object, and doesn't come from the prototype
			if (!playerData.hasOwnProperty(key)) {
				continue;
			}

			var venueIdx = playerData[key]["venue"] === "away" ? 0 : 1;
			var shiftsInPrd = playerData[key]["shifts"].filter(function(d) { return d["period"] === prd; });
			shiftsInPrd.forEach(function(sh) {
				for (var t = sh["start"]; t < sh["end"]; t++) {
					if (playerData[key]["position"] === "g") {
						seconds[t]["goalies"][venueIdx].push(playerData[key]["id"]);
					} else {
						seconds[t]["skaters"][venueIdx].push(playerData[key]["id"]);
					}
				}
			});
		}

		// Record strength situation at each second
		seconds.forEach(function(sec) {
			if (sec["goalies"][0].length < 1 || sec["goalies"][1].length < 1) {
				sec["strengthSits"] = ["other", "other"];
			} else if (sec["skaters"][0].length === 5 && sec["skaters"][1].length === 5) {
				sec["strengthSits"] = ["ev5", "ev5"];
			} else if (sec["skaters"][0].length > sec["skaters"][1].length
				&& sec["skaters"][0].length <= 6
				&& sec["skaters"][1].length >= 3) {
				sec["strengthSits"] = ["pp", "sh"];
			} else if (sec["skaters"][1].length > sec["skaters"][0].length
				&& sec["skaters"][1].length <= 6
				&& sec["skaters"][0].length >= 3) {
				sec["strengthSits"] = ["sh", "pp"];
			} else {
				sec["strengthSits"] = ["other", "other"];
			}
		});

		// For each second, record the score
		// For goals scored in previous period, add the goal to every second of the current period
		// For goals in the current period:
		// 		If goal time = 0: increment 0:00 - 0:01 (idx0) and onwards
		// 		If goal time = 1: don't increment 0:00 - 0:01, but increment 0:01 - 0:02 (idx1) and onwards
		// 		If goal time = 2: don't increment 0:01 - 0:02, but increment 0:02 - 0:03 (idx2) and onwards
		// 		If goal time = 3: don't increment 0:02 - 0:03, but increment 0:03 - 0:04 (idx3) and onwards
		// 		If goal time = 4 and the period is 4s long: don't increment 0:03 - 0:04, and there are no subsequent slots to increment

		var goals = eventData.filter(function(d) { return d["type"] === "goal" && d["period"] <= prd; });
		goals.forEach(function(g) {

			var venueIdx = g["venue"] === "away" ? 0 : 1;
			
			if (g["period"] < prd) {
				seconds.forEach(function(sec) {
					sec["score"][venueIdx]++;
				});
			} else {
				var secsToIncrement = seconds.filter(function(sec, idx) { return idx >= g["time"]; });
				secsToIncrement.forEach(function(sec) {
					sec["score"][venueIdx]++;
				});
			}
		});

		console.log(seconds);
	}
}

// Convert mm:ss to seconds
function toSecs(timeString) {
	var mm = +timeString.substring(0, timeString.indexOf(":"));
	var ss = +timeString.substring(timeString.indexOf(":") + 1);
	return 60 * mm + ss;
}

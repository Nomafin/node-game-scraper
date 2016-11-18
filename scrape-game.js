// Usage: node scrape-game.js season startGameId [endGameId]
// season: the year in which a season started. The 2016-2017 season would be specified as 2016
// startGameId & endGameId: 5 digits long (e.g., 20243)
// If endGameId is specified, all games between startGameId and endGameId (inclusive) are scraped

// Parse and store arguments
var season = parseInt(process.argv[2]);
var startGameId = parseInt(process.argv[3]);
var endGameId = parseInt(process.argv[4]);

// Validate arguments
if (!season) {
	console.log("Invalid season.");
	return;
} else if (!startGameId) {
	console.log("Invalid starting game ID.");
	return;
}

// Create array of game ids
// Use the full id including the season — 2016 season + game 20243 becomes 2016020243
var gameIds = [season * 1000000 + startGameId];
if (endGameId) {
	gameIds = [];
	for (var i = startGameId; i <= endGameId; i++) {
		gameIds.push(season * 1000000 + i);
	}
}
console.log("Games to scrape: " + gameIds);


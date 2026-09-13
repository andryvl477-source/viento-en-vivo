var express = require("express");
var moment = require("moment");
var http = require('http');
var request = require('request');
var fs = require('fs');
var Q = require('q');
var cors = require('cors');

var app = express();
var port = process.env.PORT || 7000;
var baseDir ='https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl';


var REQUEST_DELAY_MS = 2500;   
var HISTORY_HOURS = 24;        
var GFS_PUBLISH_DELAY_HOURS = 4;
var isHarvesting = false;      

var corsOptions = {
	origin: true
};

app.listen(port, function(err){
	console.log("running server on port "+ port);
});

app.get('/', cors(corsOptions), function(req, res){
    res.send('hello wind-js-server.. go to /latest for wind data..');
});

app.get('/alive', cors(corsOptions), function(req, res){
	res.send('wind-js-server is alive');
});

app.get('/latest', cors(corsOptions), function(req, res){

	
	function sendLatest(targetMoment){

		var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
		var fileName = __dirname +"/json-data/"+ stamp +".json";

		res.setHeader('Content-Type', 'application/json');
		res.sendFile(fileName, {}, function (err) {
			if (err) {
				console.log(stamp +' doesnt exist yet, trying previous interval..');
				sendLatest(moment(targetMoment).subtract(6, 'hours'));
			}
		});
	}

	sendLatest(moment().utc());

});

app.get('/nearest', cors(corsOptions), function(req, res, next){

	var time = req.query.timeIso;
	var limit = req.query.searchLimit;
	var searchForwards = false;


	function sendNearestTo(targetMoment){

		if( limit && Math.abs( moment.utc(time).diff(targetMoment, 'days'))  >= limit) {
			if(!searchForwards){
				searchForwards = true;
				sendNearestTo(moment(targetMoment).add(limit, 'days'));
				return;
			}
			else {
				return next(new Error('No data within searchLimit'));
			}
		}

		var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
		var fileName = __dirname +"/json-data/"+ stamp +".json";

		res.setHeader('Content-Type', 'application/json');
		res.sendFile(fileName, {}, function (err) {
			if(err) {
				var nextTarget = searchForwards ? moment(targetMoment).add(6, 'hours') : moment(targetMoment).subtract(6, 'hours');
				sendNearestTo(nextTarget);
			}
		});
	}

	if(time && moment(time).isValid()){
		sendNearestTo(moment.utc(time));
	}
	else {
		return next(new Error('Invalid params, expecting: timeIso=ISO_TIME_STRING'));
	}

});


setInterval(function(){

	run(moment.utc().subtract(GFS_PUBLISH_DELAY_HOURS, 'hours'));

}, 900000);


function run(targetMoment){

	
	if(isHarvesting){
		console.log('ya hay una busqueda en curso, se omite esta corrida');
		return;
	}
	isHarvesting = true;

	getGribData(targetMoment).then(function(response){
		if(response.stamp){
			convertGribToJson(response.stamp, response.targetMoment);
		}
		else {
			isHarvesting = false;
		}
	}).catch(function(){
		isHarvesting = false;
	});
}


function cleanupOldFiles(){
	var dir = __dirname + '/json-data';
	if(!checkPath(dir, false)) return;

	var cutoff = moment.utc().subtract(HISTORY_HOURS + 12, 'hours');

	fs.readdir(dir, function(err, files){
		if(err) return;
		files.forEach(function(file){
			var match = file.match(/^(\d{8})(\d{2})\.json$/);
			if(!match) return;
			var fileMoment = moment.utc(match[1] + match[2], 'YYYYMMDDHH');
			if(fileMoment.isValid() && fileMoment.isBefore(cutoff)){
				fs.unlink(dir + '/' + file, function(){
					console.log('borrado json viejo: ' + file);
				});
			}
		});
	});
}


function getGribData(targetMoment){

	var deferred = Q.defer();

	function runQuery(targetMoment){

        
		if (moment.utc().diff(targetMoment, 'days') > 3){
	        console.log('hit limit, harvest complete or there is a big gap in data..');
	        
	        deferred.resolve({stamp: false, targetMoment: false});
            return;
        }

		var stamp = moment(targetMoment).format('YYYYMMDD') + roundHours(moment(targetMoment).hour(), 6);
		var dateFolder = moment(targetMoment).format('YYYYMMDD');
		var hourFolder = roundHours(moment(targetMoment).hour(), 6);
		request.get({
			url: baseDir,
			qs: {
				file: 'gfs.t'+ roundHours(moment(targetMoment).hour(), 6) +'z.pgrb2.1p00.f000',
				lev_10_m_above_ground: 'on',
				lev_surface: 'on',
				var_TMP: 'on',
				var_UGRD: 'on',
				var_VGRD: 'on',
				leftlon: 0,
				rightlon: 360,
				toplat: 90,
				bottomlat: -90,
				dir: '/gfs.'+dateFolder+'/'+hourFolder+'/atmos'
			},
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			}

		}).on('error', function(err){
		
			setTimeout(function(){ runQuery(moment(targetMoment).subtract(6, 'hours')); }, REQUEST_DELAY_MS);

		}).on('response', function(response) {

			console.log('response '+response.statusCode + ' | '+stamp);

			if(response.statusCode != 200){
				setTimeout(function(){ runQuery(moment(targetMoment).subtract(6, 'hours')); }, REQUEST_DELAY_MS);
			}

			else {
			
				if(!checkPath('json-data/'+ stamp +'.json', false)) {

					console.log('piping ' + stamp);

				
					checkPath('grib-data', true);

					
					var file = fs.createWriteStream("grib-data/"+stamp+".f000");
					response.pipe(file);
					file.on('finish', function() {
						file.close();
						deferred.resolve({stamp: stamp, targetMoment: targetMoment});
					});

				}
				else {
					console.log('already have '+ stamp +', not looking further');
					deferred.resolve({stamp: false, targetMoment: false});
				}
			}
		});

	}

	runQuery(targetMoment);
	return deferred.promise;
}

function convertGribToJson(stamp, targetMoment){


	checkPath('json-data', true);

	var exec = require('child_process').exec, child;

	child = exec('converter/bin/grib2json --data --output json-data/'+stamp+'.json --names --compact grib-data/'+stamp+'.f000',
		{maxBuffer: 500*1024},
		function (error, stdout, stderr){

			if(error){
				console.log('exec error: ' + error);
				isHarvesting = false;
			}

			else {
				console.log("converted..");

				
				exec('rm grib-data/*');

				
				var prevMoment = moment(targetMoment).subtract(6, 'hours');
				var prevStamp = prevMoment.format('YYYYMMDD') + roundHours(prevMoment.hour(), 6);
				var withinHistoryWindow = moment.utc().diff(prevMoment, 'hours') <= HISTORY_HOURS;

				if(withinHistoryWindow && !checkPath('json-data/'+ prevStamp +'.json', false)){

					console.log("attempting to harvest older data "+ stamp);
					
					isHarvesting = false;
					setTimeout(function(){ run(prevMoment); }, REQUEST_DELAY_MS);
				}

				else {
					console.log('got enough recent history, no need to harvest further');
					isHarvesting = false;
				}

				cleanupOldFiles();
			}
		});
}


function roundHours(hours, interval){
	if(interval > 0){
		var result = (Math.floor(hours / interval) * interval);
		return result < 10 ? '0' + result.toString() : result;
	}
}


function checkPath(path, mkdir) {
    try {
	    fs.statSync(path);
	    return true;

    } catch(e) {
        if(mkdir){
	        fs.mkdirSync(path);
        }
	    return false;
    }
}


run(moment.utc().subtract(GFS_PUBLISH_DELAY_HOURS, 'hours'));

setInterval(cleanupOldFiles, 3600000);

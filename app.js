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

// ─── Configuracion de comportamiento del harvester ───
var REQUEST_DELAY_MS = 2500;   // pausa entre cada peticion a NOAA (evita saturar/que nos bloqueen)
var HISTORY_HOURS = 24;        // cuanto historial guardamos ademas de lo mas reciente
var GFS_PUBLISH_DELAY_HOURS = 4; // GFS tarda ~4h en publicarse tras cada corrida (00/06/12/18 UTC)
var isHarvesting = false;      // evita que dos busquedas corran encimadas al mismo tiempo

// cors config — datos públicos de solo lectura, se permite cualquier origen
// (antes solo dejaba pasar localhost y un dominio de GitHub Pages, por lo
// que la app real quedaba bloqueada por CORS sin importar lo demás).
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

	/**
	 * Find and return the latest available 6 hourly pre-parsed JSON data
	 *
	 * @param targetMoment {Object} UTC moment
	 */
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

	/**
	 * Find and return the nearest available 6 hourly pre-parsed JSON data
	 * If limit provided, searches backwards to limit, then forwards to limit before failing.
	 *
	 * @param targetMoment {Object} UTC moment
	 */
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

/**
 *
 * Ping for new data every 15 mins
 *
 */
setInterval(function(){

	run(moment.utc().subtract(GFS_PUBLISH_DELAY_HOURS, 'hours'));

}, 900000);

/**
 *
 * @param targetMoment {Object} moment to check for new data
 */
function run(targetMoment){

	// Evita que dos cosechas corran al mismo tiempo (por ejemplo si el
	// intervalo de 15 min dispara mientras la corrida anterior sigue
	// buscando historial hacia atras) — antes podian duplicarse y
	// mandar el doble de peticiones a NOAA sin necesidad.
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

/**
 *
 * Borra archivos json-data/*.json mas viejos que HISTORY_HOURS + margen,
 * para que el disco no crezca sin limite mientras el servidor sigue vivo.
 *
 */
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

/**
 *
 * Finds and returns the latest 6 hourly GRIB2 data from NOAAA
 *
 * @returns {*|promise}
 */
function getGribData(targetMoment){

	var deferred = Q.defer();

	function runQuery(targetMoment){

        // Solo busca 3 dias hacia atras (antes eran 30: podia disparar hasta
        // ~120 peticiones seguidas a NOAA en una sola corrida). GFS publica cada
        // 6h con pocas horas de retraso, asi que con 3 dias sobra de margen.
		if (moment.utc().diff(targetMoment, 'days') > 3){
	        console.log('hit limit, harvest complete or there is a big gap in data..');
	        // Resolvemos igual (sin stamp) para que run() libere isHarvesting;
	        // si no, el mutex se quedaria trabado para siempre.
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
			// console.log(err);
			setTimeout(function(){ runQuery(moment(targetMoment).subtract(6, 'hours')); }, REQUEST_DELAY_MS);

		}).on('response', function(response) {

			console.log('response '+response.statusCode + ' | '+stamp);

			if(response.statusCode != 200){
				setTimeout(function(){ runQuery(moment(targetMoment).subtract(6, 'hours')); }, REQUEST_DELAY_MS);
			}

			else {
				// don't rewrite stamps
				if(!checkPath('json-data/'+ stamp +'.json', false)) {

					console.log('piping ' + stamp);

					// mk sure we've got somewhere to put output
					checkPath('grib-data', true);

					// pipe the file, resolve the valid time stamp
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

	// mk sure we've got somewhere to put output
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

				// don't keep raw grib data
				exec('rm grib-data/*');

				// Solo cosecha historial hacia atras hasta cubrir HISTORY_HOURS de
				// margen (antes seguia indefinidamente, llenando el disco con json
				// viejo que la app ni usa: solo se consulta /latest).
				var prevMoment = moment(targetMoment).subtract(6, 'hours');
				var prevStamp = prevMoment.format('YYYYMMDD') + roundHours(prevMoment.hour(), 6);
				var withinHistoryWindow = moment.utc().diff(prevMoment, 'hours') <= HISTORY_HOURS;

				if(withinHistoryWindow && !checkPath('json-data/'+ prevStamp +'.json', false)){

					console.log("attempting to harvest older data "+ stamp);
					// Liberamos el mutex antes de encadenar la siguiente busqueda:
					// run() lo vuelve a tomar de inmediato, así que sigue siendo
					// una sola cadena secuencial, nunca dos corridas a la vez.
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

/**
 *
 * Round hours to expected interval, e.g. we're currently using 6 hourly interval
 * i.e. 00 || 06 || 12 || 18
 *
 * @param hours
 * @param interval
 * @returns {String}
 */
function roundHours(hours, interval){
	if(interval > 0){
		var result = (Math.floor(hours / interval) * interval);
		return result < 10 ? '0' + result.toString() : result;
	}
}

/**
 * Sync check if path or file exists
 *
 * @param path {string}
 * @param mkdir {boolean} create dir if doesn't exist
 * @returns {boolean}
 */
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

// init harvest
// Restamos GFS_PUBLISH_DELAY_HOURS para no gastar el primer intento en la
// corrida mas nueva, que casi seguro NOAA todavia no ha publicado.
run(moment.utc().subtract(GFS_PUBLISH_DELAY_HOURS, 'hours'));

// Limpieza de archivos viejos cada hora, ademas de la que ya ocurre tras
// cada conversion exitosa.
setInterval(cleanupOldFiles, 3600000);
